import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CORE_DEFAULT_HOST,
  CORE_DEFAULT_PORT,
  type ProviderId,
  type Settings,
  type SttProvider,
  type TextCorrectionProvider,
} from "@lvf/shared";
import { Database } from "./db/database.js";
import { EventBus } from "./events.js";
import { Logger } from "./logger.js";
import { Pipeline } from "./pipeline.js";
import { ServerContext } from "./context.js";
import { buildServer } from "./server.js";
import { ensureDirectories, resolvePaths } from "./paths.js";
import { ClaudeCliProvider } from "./providers/claude.js";
import { CodexCliProvider } from "./providers/codex.js";
import { MockCorrectionProvider, MockSttProvider } from "./providers/mock.js";
import {
  SttWorkerClient,
  defaultWorkerDir,
  defaultWorkerPython,
} from "./stt/worker-client.js";

/**
 * Walks up from this file to the repository root.
 * Works both from `src/` (tsx/strip-types) and from `dist/` after a build.
 */
function findRepoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i += 1) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // Installed layout: the app bundle keeps prompts/ next to the built core.
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
}

async function main(): Promise<void> {
  const repoRoot = process.env.LVF_REPO_ROOT ?? findRepoRoot();
  const port = Number(process.env.LVF_PORT ?? CORE_DEFAULT_PORT);
  const host = process.env.LVF_HOST ?? CORE_DEFAULT_HOST;

  if (host !== "127.0.0.1" && host !== "localhost" && host !== "::1") {
    throw new Error(`refusing to bind to a non-loopback host: ${host}`);
  }

  const paths = resolvePaths();
  ensureDirectories(paths);

  const db = Database.open(paths.dbFile);
  const settings = db.getSettings();

  const logger = Logger.create({
    level: settings.privacy.logLevel,
    logsDir: paths.logsDir,
    fileName: "core.log",
    context: { component: "core" },
    echo: process.env.LVF_LOG_ECHO !== "0",
  });

  logger.info("core starting", {
    version: "0.1.0",
    port,
    node: process.versions.node,
    dbFile: paths.dbFile,
  });

  const events = new EventBus();

  // --- Speech-to-text -------------------------------------------------------
  const useMockStt = process.env.LVF_MOCK === "1" || settings.stt.backend === "mock";
  const workerPython = process.env.LVF_STT_PYTHON ?? defaultWorkerPython(repoRoot);
  const workerDir = process.env.LVF_STT_DIR ?? defaultWorkerDir(repoRoot);

  const sttWorker = useMockStt
    ? undefined
    : new SttWorkerClient({
        pythonPath: workerPython,
        workerDir,
        model: settings.stt.model,
        warmUp: settings.stt.warmUpOnStart,
        logger: logger.child({ component: "stt" }),
        requestTimeoutMs: settings.stt.timeoutMs,
      });

  const stt: SttProvider = sttWorker ?? new MockSttProvider();

  if (sttWorker) {
    sttWorker.on("health", (health) => {
      events.publish({
        type: "stt-status",
        at: new Date().toISOString(),
        ready: health.ready,
        state: health.state,
        ...(health.model ? { model: health.model } : {}),
        ...(health.error ? { error: health.error } : {}),
      });
    });
    sttWorker.start();
  }

  // --- Text correction ------------------------------------------------------
  const providers = new Map<ProviderId, TextCorrectionProvider>();
  providers.set("claude-cli", new ClaudeCliProvider({ workDir: paths.cliWorkDir }));
  providers.set("openai-codex-cli", new CodexCliProvider({ workDir: paths.cliWorkDir }));
  providers.set("mock", new MockCorrectionProvider());

  const ctxHolder: { ctx?: ServerContext } = {};

  const pipeline = new Pipeline({
    db,
    paths,
    logger,
    events,
    stt,
    providers,
    loadSystemPrompt: () => ctxHolder.ctx!.loadSystemPrompt(),
  });

  const ctx = new ServerContext({
    db,
    paths,
    logger,
    events,
    stt,
    providers,
    pipeline,
    port,
    repoRoot,
    onSttSettingsChanged: (next: Settings) => {
      sttWorker?.reconfigure({ model: next.stt.model, warmUp: next.stt.warmUpOnStart });
    },
  });
  ctxHolder.ctx = ctx;

  const webDir = process.env.LVF_WEB_DIR ?? join(repoRoot, "apps", "web", "dist");
  const { app, dashboardUrl } = buildServer({ ctx, webDir });

  await app.listen({ host, port });

  const url = dashboardUrl(host, port);
  logger.info("core listening", { host, port, webDir: existsSync(webDir) ? webDir : "(not built)" });
  // Printed to stdout, not the log file: the token belongs in the terminal the user is
  // looking at, not in a file that gets shipped around.
  process.stdout.write(`\nLocalVoiceFlow dashboard: ${url}\n\n`);

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info("core shutting down", { signal });
    try {
      await app.close();
      await sttWorker?.stop();
      db.close();
      await logger.close();
    } finally {
      process.exit(0);
    }
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  // The parent (menu-bar agent or start.sh) going away must not leave an orphan holding
  // the port and a 1.6 GB Python child.
  process.on("disconnect", () => void shutdown("disconnect"));
}

main().catch((error: unknown) => {
  process.stderr.write(`core failed to start: ${String(error)}\n`);
  process.exit(1);
});
