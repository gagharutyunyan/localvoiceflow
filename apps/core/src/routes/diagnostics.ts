import { spawn } from "node:child_process";
import { arch, release } from "node:os";
import { existsSync, rmSync, statSync } from "node:fs";
import { z } from "zod";
import {
  APP_VERSION,
  AgentStatusSchema,
  ModelIdSchema,
  type ProviderId,
} from "@lvf/shared";
import type { FastifyInstance } from "fastify";
import type { ServerContext } from "../context.js";
import { detectApiKeyEnv } from "../providers/spawn.js";
import { resolveExecutable } from "../providers/which.js";

const TestProviderSchema = z.object({
  provider: z.enum(["claude-cli", "openai-codex-cli", "mock"]),
  model: ModelIdSchema,
  effort: z.string().trim().min(1).max(32),
  /** Optional sample; defaults to a short fixed Russian phrase. */
  sample: z.string().max(2000).optional(),
});

const TestTranscriptionSchema = z.object({
  fixture: z.enum(["bundled", "last-stored"]).default("bundled"),
});

const OpenSchema = z.object({ target: z.enum(["data", "logs", "audio"]) });

const DEFAULT_TEST_SAMPLE =
  "так смотри этот юз эффект каждый раз когда обновляется юзер дата снова вызывает фетч надо это убрать";

/** macOS marketing version, derived from the Darwin release when `sw_vers` is unavailable. */
async function macosVersion(): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn("/usr/bin/sw_vers", ["-productVersion"], { shell: false });
    let out = "";
    child.stdout.on("data", (chunk: Buffer) => {
      out += chunk.toString("utf8");
    });
    child.on("error", () => resolve(`darwin ${release()}`));
    child.on("close", () => resolve(out.trim() || `darwin ${release()}`));
  });
}

export function registerDiagnosticsRoutes(app: FastifyInstance, ctx: ServerContext): void {
  app.get("/api/diagnostics", async (_request, reply) => {
    const [claudeHealth, codexHealth, sttHealth, osVersion] = await Promise.all([
      ctx.providers.get("claude-cli")!.health(),
      ctx.providers.get("openai-codex-cli")!.health(),
      ctx.stt.health(),
      macosVersion(),
    ]);

    const settings = ctx.db.getSettings();

    return reply.send({
      app: {
        version: APP_VERSION,
        uptimeMs: Math.round(performance.now()),
        port: ctx.port,
        dataDir: ctx.paths.dataDir,
        logsDir: ctx.paths.logsDir,
        audioDir: settings.stt.audioDirectory.trim() || ctx.paths.audioDir,
        dbFile: ctx.paths.dbFile,
        sqliteWritable: ctx.db.isWritable(),
      },
      system: {
        macos: osVersion,
        arch: arch(),
        appleSilicon: arch() === "arm64",
        node: process.versions.node,
      },
      stt: sttHealth,
      permissions: ctx.agentStatus,
      providers: {
        claude: claudeHealth,
        codex: codexHealth,
      },
      // Names only — a value is never read out of the environment.
      apiKeyEnvPresent: detectApiKeyEnv(),
      active: {
        provider: settings.correction.provider,
        model: settings.correction.model,
        effort: settings.correction.effort,
        profile: settings.correction.profile,
        sttBackend: settings.stt.backend,
        sttModel: settings.stt.model,
        sttLanguage: settings.stt.language,
      },
      lastError: ctx.lastError,
      lastDictation: ctx.db.lastDictation(),
    });
  });

  app.post("/api/diagnostics/test-provider", async (request, reply) => {
    const parsed = TestProviderSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: { code: "bad_request", message: parsed.error.message } });
    }

    const provider = ctx.providers.get(parsed.data.provider as ProviderId);
    if (!provider) {
      return reply
        .code(400)
        .send({ error: { code: "bad_request", message: "unknown provider" } });
    }

    const settings = ctx.db.getSettings();
    const started = process.hrtime.bigint();
    try {
      const result = await provider.correct(
        {
          rawTranscript: parsed.data.sample ?? DEFAULT_TEST_SAMPLE,
          language: "ru",
          glossary: [
            { canonical: "useEffect", aliases: ["юз эффект"] },
            { canonical: "userData", aliases: ["юзер дата"] },
            { canonical: "fetch", aliases: ["фетч"] },
          ],
          profile: "developer",
        },
        {
          model: parsed.data.model,
          effort: parsed.data.effort,
          timeoutMs: settings.correction.timeoutMs,
          systemPrompt: ctx.loadSystemPrompt(),
          disableThinking: settings.correction.disableThinking,
        },
      );

      ctx.db.markPresetOk(parsed.data.provider, parsed.data.model, parsed.data.effort);

      return reply.send({
        ok: true,
        provider: result.provider,
        model: result.model,
        effort: result.effort,
        latencyMs: Math.round(result.latencyMs),
        sample: result.finalText,
        warnings: result.warnings,
        checkedAt: new Date().toISOString(),
      });
    } catch (error) {
      const code = (error as { code?: string }).code ?? "llm_failed";
      return reply.send({
        ok: false,
        provider: parsed.data.provider,
        model: parsed.data.model,
        effort: parsed.data.effort,
        latencyMs: Math.round(Number(process.hrtime.bigint() - started) / 1e6),
        error: { code, message: (error as Error).message },
        checkedAt: new Date().toISOString(),
      });
    }
  });

  app.post("/api/diagnostics/test-transcription", async (request, reply) => {
    const parsed = TestTranscriptionSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: { code: "bad_request", message: parsed.error.message } });
    }

    // The client picks from an enum; it can never name an arbitrary path.
    const fixture = ctx.fixtureAudioPath();
    if (!fixture || !existsSync(fixture)) {
      return reply.code(404).send({
        error: {
          code: "not_found",
          message: "no audio fixture available — run `make fixtures` to generate one",
        },
      });
    }

    try {
      const started = process.hrtime.bigint();
      const result = await ctx.stt.transcribe({
        audioPath: fixture,
        language: ctx.db.getSettings().stt.language,
        requestId: `diag_${Date.now()}`,
      });
      return reply.send({
        ok: true,
        transcript: result.rawTranscript,
        detectedLanguage: result.detectedLanguage,
        audioDurationMs: result.audioDurationMs,
        latencyMs: Math.round(Number(process.hrtime.bigint() - started) / 1e6),
        transcriptionMs: Math.round(result.transcriptionMs),
        model: result.model,
        noSpeech: result.noSpeech,
        warnings: result.warnings,
      });
    } catch (error) {
      const code = (error as { code?: string }).code ?? "stt_failed";
      return reply.send({ ok: false, error: { code, message: (error as Error).message } });
    }
  });

  app.post("/api/diagnostics/open", async (request, reply) => {
    const parsed = OpenSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: { code: "bad_request", message: parsed.error.message } });
    }
    const settings = ctx.db.getSettings();
    const dir =
      parsed.data.target === "logs"
        ? ctx.paths.logsDir
        : parsed.data.target === "audio"
          ? settings.stt.audioDirectory.trim() || ctx.paths.audioDir
          : ctx.paths.dataDir;

    spawn("/usr/bin/open", [dir], { shell: false, detached: true, stdio: "ignore" }).unref();
    return reply.send({ opened: dir });
  });

  app.post("/api/diagnostics/delete-audio", async (_request, reply) => {
    let removed = 0;
    for (const path of ctx.db.allAudioPaths()) {
      if (existsSync(path)) {
        rmSync(path, { force: true });
        removed += 1;
      }
    }
    return reply.send({ removed });
  });

  app.get("/api/diagnostics/export", async (_request, reply) => {
    const settings = ctx.db.getSettings();
    const history = ctx.db.listDictations({ limit: 500, offset: 0 });
    return reply
      .header("content-type", "application/json; charset=utf-8")
      .header("content-disposition", 'attachment; filename="local-voice-flow-export.json"')
      .send(
        JSON.stringify(
          {
            exportedAt: new Date().toISOString(),
            version: APP_VERSION,
            settings,
            dictionary: ctx.db.listTerms(),
            appProfiles: ctx.db.listAppProfiles(),
            providerPresets: ctx.db.listProviderPresets(),
            history: history.items,
          },
          null,
          2,
        ),
      );
  });

  // --- Agent-facing ---------------------------------------------------------

  app.post("/api/agent/status", async (request, reply) => {
    const parsed = AgentStatusSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: { code: "bad_request", message: parsed.error.message } });
    }
    ctx.setAgentStatus(parsed.data);
    return reply.send({ ok: true });
  });

  app.get("/api/agent/config", async (_request, reply) => {
    const settings = ctx.db.getSettings();
    return reply.send({
      enabled: settings.general.enabled,
      hudEnabled: settings.general.hudEnabled,
      soundFeedbackEnabled: settings.general.soundFeedbackEnabled,
      fnTriggerEnabled: settings.general.fnTriggerEnabled,
      fallbackHotkeyEnabled: settings.general.fallbackHotkeyEnabled,
      fallbackHotkey: settings.general.fallbackHotkey,
      doubleTapWindowMs: settings.general.doubleTapWindowMs,
      minRecordingMs: settings.general.minRecordingMs,
      maxRecordingSeconds: settings.general.maxRecordingSeconds,
      endLockedRecordingWithEnter: settings.general.endLockedRecordingWithEnter,
      targetChangedBehavior: settings.general.targetChangedBehavior,
      restoreClipboardAfterPaste: settings.general.restoreClipboardAfterPaste,
      clipboardRestoreDelayMs: settings.general.clipboardRestoreDelayMs,
      sendWindowTitle: settings.correction.sendWindowTitle,
    });
  });

  // Reports the resolved CLI paths so `doctor.sh` does not have to guess them.
  app.get("/api/diagnostics/paths", async (_request, reply) => {
    const [claude, codex] = await Promise.all([
      resolveExecutable("claude"),
      resolveExecutable("codex"),
    ]);
    let dbSize: number | undefined;
    try {
      dbSize = statSync(ctx.paths.dbFile).size;
    } catch {
      dbSize = undefined;
    }
    return reply.send({
      claude: claude ?? null,
      codex: codex ?? null,
      node: process.execPath,
      dbFile: ctx.paths.dbFile,
      dbSizeBytes: dbSize ?? null,
    });
  });
}
