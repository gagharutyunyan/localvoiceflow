import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { CorrectionInput, ProviderId, TextCorrectionProvider } from "@lvf/shared";
import { ClaudeCliProvider } from "./providers/claude.js";
import { CodexCliProvider } from "./providers/codex.js";
import { resolvePaths, ensureDirectories } from "./paths.js";
import { containsTerm, leaksTerm } from "./fixture-match.js";

/**
 * Real-provider smoke test. Kept out of the unit suite on purpose: it spends the user's
 * paid subscription quota, so it only ever runs from `make smoke-claude` / `make smoke-openai`.
 */

interface Args {
  provider: ProviderId;
  model: string;
  effort: string;
  timeoutMs: number;
}

function parseArgs(argv: readonly string[]): Args {
  const args: Args = {
    provider: "claude-cli",
    model: "haiku",
    effort: "low",
    timeoutMs: 60_000,
  };
  for (const raw of argv) {
    if (!raw.startsWith("--")) continue;
    const [key, value] = raw.slice(2).split("=");
    if (key === "provider" && value) args.provider = value as ProviderId;
    if (key === "model" && value) args.model = value;
    if (key === "effort" && value) args.effort = value;
    if (key === "timeout" && value) args.timeoutMs = Number(value);
  }
  if (args.provider === "openai-codex-cli" && args.model === "haiku") {
    args.model = "gpt-5.6-luna";
    args.effort = "none";
  }
  return args;
}

function repoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i += 1) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) return dir;
    dir = dirname(dir);
  }
  return process.cwd();
}

interface Fixture {
  id: string;
  raw: string;
  mustContain: string[];
  mustNotContain?: string[];
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const root = repoRoot();
  const paths = resolvePaths();
  ensureDirectories(paths);

  process.stdout.write("\n");
  process.stdout.write("╭──────────────────────────────────────────────────────────────╮\n");
  process.stdout.write("│  SMOKE TEST — this spends your PAID subscription quota.       │\n");
  process.stdout.write(`│  provider: ${args.provider.padEnd(50)}│\n`);
  process.stdout.write(`│  model:    ${args.model.padEnd(50)}│\n`);
  process.stdout.write(`│  effort:   ${args.effort.padEnd(50)}│\n`);
  process.stdout.write("╰──────────────────────────────────────────────────────────────╯\n\n");

  const provider: TextCorrectionProvider =
    args.provider === "openai-codex-cli"
      ? new CodexCliProvider({ workDir: paths.cliWorkDir })
      : new ClaudeCliProvider({ workDir: paths.cliWorkDir });

  const health = await provider.health();
  process.stdout.write(`CLI            : ${health.cliPath ?? "not found"}\n`);
  process.stdout.write(`version        : ${health.version ?? "unknown"}\n`);
  process.stdout.write(`authenticated  : ${health.authenticated ? "yes" : "NO"} (${health.authDetail ?? "-"})\n`);
  if (health.apiKeyEnvPresent.length > 0) {
    process.stdout.write(
      `WARNING        : ${health.apiKeyEnvPresent.join(", ")} set in the environment; removed for these calls\n`,
    );
  }
  if (health.missingFlags.length > 0) {
    process.stdout.write(`missing flags  : ${health.missingFlags.join(", ")}\n`);
  }
  process.stdout.write("\n");

  if (!health.available || !health.authenticated) {
    process.stderr.write("The CLI is unavailable or not signed in — aborting before spending anything.\n");
    process.exit(2);
  }

  const fixturesFile = join(root, "fixtures", "transcription", "ru-technical.json");
  const fixtures = (JSON.parse(readFileSync(fixturesFile, "utf8")) as { fixtures: Fixture[] }).fixtures;

  const systemPrompt = readFileSync(join(root, "prompts", "transcription-editor.md"), "utf8");

  let passed = 0;
  const latencies: number[] = [];

  for (const fixture of fixtures) {
    const input: CorrectionInput = {
      rawTranscript: fixture.raw,
      language: "ru",
      glossary: [
        { canonical: "useEffect", aliases: ["юз эффект"] },
        { canonical: "userData", aliases: ["юзер дата"] },
        { canonical: "userId", aliases: ["юзер айди"] },
        { canonical: "UserProfile", aliases: ["юзер профайл"] },
        { canonical: "React Query", aliases: ["реакт квери"] },
        { canonical: "AbortController", aliases: ["аборт контроллер"] },
        { canonical: "fetch", aliases: ["фетч"] },
        { canonical: "pnpm", aliases: ["пи эн пи эм"] },
        { canonical: "WebStorm", aliases: ["вебшторм"] },
        { canonical: "frontend", aliases: ["фронтенд"] },
        { canonical: "component", aliases: ["компонент"] },
      ],
      profile: "developer",
    };

    try {
      const result = await provider.correct(input, {
        model: args.model,
        effort: args.effort,
        timeoutMs: args.timeoutMs,
        systemPrompt,
        disableThinking: true,
      });
      latencies.push(result.latencyMs);

      // Quality is judged by required terms and meaning preservation, never by exact
      // string equality — the model may legitimately phrase the sentence differently.
      const missing = fixture.mustContain.filter(
        (needle) => !containsTerm(result.finalText, needle),
      );
      const leaked = (fixture.mustNotContain ?? []).filter((needle) =>
        leaksTerm(result.finalText, needle),
      );
      const ok = missing.length === 0 && leaked.length === 0;
      if (ok) passed += 1;

      process.stdout.write(`[${ok ? "PASS" : "FAIL"}] ${fixture.id}  (${result.latencyMs.toFixed(0)} ms)\n`);
      process.stdout.write(`       in : ${fixture.raw}\n`);
      process.stdout.write(`       out: ${result.finalText}\n`);
      if (missing.length > 0) process.stdout.write(`       missing: ${missing.join(", ")}\n`);
      if (leaked.length > 0) process.stdout.write(`       leaked : ${leaked.join(", ")}\n`);
      process.stdout.write("\n");
    } catch (error) {
      const code = (error as { code?: string }).code ?? "unknown";
      process.stdout.write(`[FAIL] ${fixture.id}  (${code}: ${(error as Error).message})\n\n`);
    }
  }

  const avg = latencies.length > 0 ? latencies.reduce((a, b) => a + b, 0) / latencies.length : 0;
  process.stdout.write(
    `${passed}/${fixtures.length} fixtures passed; mean latency ${avg.toFixed(0)} ms\n`,
  );
  process.exit(passed === fixtures.length ? 0 : 1);
}

main().catch((error: unknown) => {
  process.stderr.write(`smoke test failed: ${String(error)}\n`);
  process.exit(1);
});
