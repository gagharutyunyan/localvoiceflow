import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import {
  applyDeterministicReplacements,
  selectGlossary,
  type CorrectionInput,
  type DictionaryTerm,
  type ProviderId,
  type TextCorrectionProvider,
} from "@lvf/shared";
import { Database } from "./db/database.js";
import { ClaudeCliProvider } from "./providers/claude.js";
import { CodexCliProvider } from "./providers/codex.js";
import { MockCorrectionProvider } from "./providers/mock.js";
import { resolvePaths, ensureDirectories, findRepoRoot } from "./paths.js";
import { containsTerm } from "./fixture-match.js";
import {
  SttWorkerClient,
  defaultWorkerDir,
  defaultWorkerPython,
} from "./stt/worker-client.js";
import { Logger } from "./logger.js";

/**
 * Measures the real critical path. Every number printed here is observed, never modelled:
 * each stage is timed with a monotonic clock around the actual work.
 */

interface Args {
  provider: ProviderId;
  model: string;
  effort: string;
  runs: number;
  skipLlm: boolean;
  skipStt: boolean;
  json?: string;
  timeoutMs: number;
}

function parseArgs(argv: readonly string[]): Args {
  const args: Args = {
    provider: "claude-cli",
    model: "haiku",
    effort: "low",
    runs: 5,
    skipLlm: false,
    skipStt: false,
    timeoutMs: 60_000,
  };

  for (const raw of argv) {
    const [key, value] = raw.startsWith("--") ? raw.slice(2).split("=") : [raw, undefined];
    switch (key) {
      case "provider":
        if (value) args.provider = value as ProviderId;
        break;
      case "model":
        if (value) args.model = value;
        break;
      case "effort":
        if (value) args.effort = value;
        break;
      case "runs":
        if (value) args.runs = Math.max(1, Number(value));
        break;
      case "skip-llm":
        args.skipLlm = true;
        break;
      case "skip-stt":
        args.skipStt = true;
        break;
      case "timeout":
        if (value) args.timeoutMs = Number(value);
        break;
      case "json":
        args.json = value ?? "benchmark-results/latest.json";
        break;
      default:
        break;
    }
  }
  return args;
}

interface Sample {
  fixture: string;
  audioPrepMs?: number;
  sttMs?: number;
  glossaryMs: number;
  llmMs?: number;
  totalMs: number;
  ok: boolean;
  error?: string;
  rawTranscript?: string;
  finalText?: string;
}

function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  // Nearest-rank: with 5 samples, p95 is the largest, which is what "worst realistic" means.
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))]!;
}

function summarize(label: string, values: readonly number[]): string {
  if (values.length === 0) return `${label.padEnd(22)} —`;
  const min = Math.min(...values);
  const max = Math.max(...values);
  return [
    label.padEnd(22),
    `n=${String(values.length).padStart(3)}`,
    `p50=${percentile(values, 50).toFixed(0).padStart(6)} ms`,
    `p95=${percentile(values, 95).toFixed(0).padStart(6)} ms`,
    `min=${min.toFixed(0).padStart(6)} ms`,
    `max=${max.toFixed(0).padStart(6)} ms`,
  ].join("  ");
}

function elapsed(from: bigint): number {
  return Number(process.hrtime.bigint() - from) / 1e6;
}

interface TextFixture {
  id: string;
  raw: string;
  mustContain: string[];
}


function loadTextFixtures(root: string): TextFixture[] {
  const file = join(root, "fixtures", "transcription", "ru-technical.json");
  if (!existsSync(file)) return [];
  const parsed = JSON.parse(readFileSync(file, "utf8")) as { fixtures: TextFixture[] };
  return parsed.fixtures;
}

function listAudioFixtures(root: string): string[] {
  const dir = join(root, "fixtures", "audio");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith(".wav"))
    .map((name) => join(dir, name))
    .sort();
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const root = findRepoRoot();
  const paths = resolvePaths();
  ensureDirectories(paths);

  const db = Database.open(paths.dbFile);
  const terms: DictionaryTerm[] = db.listEnabledTerms();
  const settings = db.getSettings();

  const logger = Logger.create({ level: "warn", echo: false });

  process.stdout.write("LocalVoiceFlow benchmark\n");
  process.stdout.write(`  provider : ${args.provider}\n`);
  process.stdout.write(`  model    : ${args.model}\n`);
  process.stdout.write(`  effort   : ${args.effort}\n`);
  process.stdout.write(`  runs     : ${args.runs}\n`);
  if (!args.skipLlm && args.provider !== "mock") {
    process.stdout.write("  NOTE: LLM stages use your paid subscription quota.\n");
  }
  process.stdout.write("\n");

  // --- STT ------------------------------------------------------------------
  const audioFixtures = listAudioFixtures(root);
  let stt: SttWorkerClient | undefined;

  if (!args.skipStt && audioFixtures.length > 0) {
    stt = new SttWorkerClient({
      pythonPath: process.env.LVF_STT_PYTHON ?? defaultWorkerPython(root),
      workerDir: process.env.LVF_STT_DIR ?? defaultWorkerDir(root),
      model: settings.stt.model,
      warmUp: true,
      logger,
      requestTimeoutMs: 180_000,
    });
    stt.start();

    process.stdout.write("Waiting for the STT worker to load the model…\n");
    const readyAt = Date.now();
    while (Date.now() - readyAt < 300_000) {
      const health = await stt.health();
      if (health.ready) {
        process.stdout.write(
          `  model loaded in ${health.loadMs ?? 0} ms on ${health.device ?? "?"}\n\n`,
        );
        break;
      }
      if (health.state === "error") {
        process.stdout.write(`  STT unavailable: ${health.error ?? "unknown"}\n\n`);
        await stt.stop();
        stt = undefined;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  } else if (!args.skipStt) {
    process.stdout.write("No audio fixtures found — skipping the STT stage.\n");
    process.stdout.write("  Generate them with: make fixtures\n\n");
  }

  // --- LLM ------------------------------------------------------------------
  const providers = new Map<ProviderId, TextCorrectionProvider>([
    ["claude-cli", new ClaudeCliProvider({ workDir: paths.cliWorkDir })],
    ["openai-codex-cli", new CodexCliProvider({ workDir: paths.cliWorkDir })],
    ["mock", new MockCorrectionProvider()],
  ]);
  const provider = providers.get(args.provider)!;

  const systemPromptFile = join(root, "prompts", "transcription-editor.md");
  const systemPrompt = existsSync(systemPromptFile)
    ? readFileSync(systemPromptFile, "utf8")
    : "Edit the dictation and return it in the structured output field \"text\".";

  const samples: Sample[] = [];
  const textFixtures = loadTextFixtures(root);

  for (let run = 0; run < args.runs; run += 1) {
    // --- audio + stt path ---
    for (const audioPath of stt ? audioFixtures : []) {
      const name = audioPath.split("/").pop()!;
      const started = process.hrtime.bigint();
      const sample: Sample = { fixture: name, glossaryMs: 0, totalMs: 0, ok: false };

      try {
        const prepStart = process.hrtime.bigint();
        // Audio preparation on this path is the file handoff; the agent already produced
        // a 16 kHz mono WAV, so there is deliberately no transcode here.
        readFileSync(audioPath);
        sample.audioPrepMs = elapsed(prepStart);

        const sttStart = process.hrtime.bigint();
        const result = await stt!.transcribe({
          audioPath,
          language: settings.stt.language,
          requestId: `bench_${run}_${name}`,
        });
        sample.sttMs = elapsed(sttStart);
        sample.rawTranscript = result.rawTranscript;

        const glossStart = process.hrtime.bigint();
        const replaced = applyDeterministicReplacements(result.rawTranscript, terms);
        const glossary = selectGlossary(terms, replaced.text, settings.correction.glossaryMaxTerms);
        sample.glossaryMs = elapsed(glossStart);

        if (!args.skipLlm) {
          const input: CorrectionInput = {
            rawTranscript: replaced.text,
            language: result.detectedLanguage ?? "ru",
            glossary: glossary.entries,
            profile: "developer",
          };
          const llmStart = process.hrtime.bigint();
          const corrected = await provider.correct(input, {
            model: args.model,
            effort: args.effort,
            timeoutMs: args.timeoutMs,
            systemPrompt,
            disableThinking: true,
          });
          sample.llmMs = elapsed(llmStart);
          sample.finalText = corrected.finalText;
        }

        sample.ok = true;
      } catch (error) {
        sample.error = error instanceof Error ? error.message : String(error);
      }

      sample.totalMs = elapsed(started);
      samples.push(sample);
      process.stdout.write(
        `  [${sample.ok ? "ok  " : "FAIL"}] ${name.padEnd(28)} ` +
          `stt=${(sample.sttMs ?? 0).toFixed(0).padStart(5)}ms ` +
          `gloss=${sample.glossaryMs.toFixed(1).padStart(5)}ms ` +
          `llm=${(sample.llmMs ?? 0).toFixed(0).padStart(6)}ms ` +
          `total=${sample.totalMs.toFixed(0).padStart(6)}ms\n`,
      );
    }

    // --- text-only path (LLM correction on canned transcripts) ---
    for (const fixture of args.skipLlm ? [] : textFixtures) {
      const started = process.hrtime.bigint();
      const sample: Sample = { fixture: fixture.id, glossaryMs: 0, totalMs: 0, ok: false };

      try {
        const glossStart = process.hrtime.bigint();
        const replaced = applyDeterministicReplacements(fixture.raw, terms);
        const glossary = selectGlossary(terms, replaced.text, settings.correction.glossaryMaxTerms);
        sample.glossaryMs = elapsed(glossStart);
        sample.rawTranscript = fixture.raw;

        const llmStart = process.hrtime.bigint();
        const corrected = await provider.correct(
          {
            rawTranscript: replaced.text,
            language: "ru",
            glossary: glossary.entries,
            profile: "developer",
          },
          {
            model: args.model,
            effort: args.effort,
            timeoutMs: args.timeoutMs,
            systemPrompt,
            disableThinking: true,
          },
        );
        sample.llmMs = elapsed(llmStart);
        sample.finalText = corrected.finalText;

        // Quality is checked by required terms, not string equality: the model is free
        // to phrase the sentence differently as long as the meaning-bearing terms survive.
        const missing = fixture.mustContain.filter((needle) => !containsTerm(corrected.finalText, needle));
        sample.ok = missing.length === 0;
        if (!sample.ok) sample.error = `missing terms: ${missing.join(", ")}`;
      } catch (error) {
        sample.error = error instanceof Error ? error.message : String(error);
      }

      sample.totalMs = elapsed(started);
      samples.push(sample);
      process.stdout.write(
        `  [${sample.ok ? "ok  " : "FAIL"}] ${fixture.id.padEnd(28)} ` +
          `gloss=${sample.glossaryMs.toFixed(1).padStart(5)}ms ` +
          `llm=${(sample.llmMs ?? 0).toFixed(0).padStart(6)}ms ` +
          `total=${sample.totalMs.toFixed(0).padStart(6)}ms` +
          `${sample.error ? `  (${sample.error})` : ""}\n`,
      );
    }
  }

  await stt?.stop();
  db.close();

  // --- Report ---------------------------------------------------------------
  const ok = samples.filter((s) => s.ok);
  const failed = samples.filter((s) => !s.ok);

  process.stdout.write("\n─────────────────────────────────────────────────────────────────────\n");
  process.stdout.write(summarize("audio preparation", samples.map((s) => s.audioPrepMs).filter((v): v is number => v !== undefined)) + "\n");
  process.stdout.write(summarize("stt", samples.map((s) => s.sttMs).filter((v): v is number => v !== undefined)) + "\n");
  process.stdout.write(summarize("glossary", samples.map((s) => s.glossaryMs)) + "\n");
  process.stdout.write(summarize(`llm (${args.provider})`, samples.map((s) => s.llmMs).filter((v): v is number => v !== undefined)) + "\n");
  process.stdout.write(summarize("total", samples.map((s) => s.totalMs)) + "\n");
  process.stdout.write("─────────────────────────────────────────────────────────────────────\n");
  process.stdout.write(`succeeded: ${ok.length}    failed: ${failed.length}\n`);
  for (const sample of failed) {
    process.stdout.write(`  FAIL ${sample.fixture}: ${sample.error ?? "unknown"}\n`);
  }

  if (args.json) {
    // An absolute --json path is used as given; only relative paths are repo-anchored.
    const outFile = isAbsolute(args.json) ? args.json : join(root, args.json);
    mkdirSync(dirname(outFile), { recursive: true });
    writeFileSync(
      outFile,
      JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          config: args,
          samples,
          summary: {
            stt: statsOf(samples.map((s) => s.sttMs)),
            glossary: statsOf(samples.map((s) => s.glossaryMs)),
            llm: statsOf(samples.map((s) => s.llmMs)),
            total: statsOf(samples.map((s) => s.totalMs)),
            succeeded: ok.length,
            failed: failed.length,
          },
        },
        null,
        2,
      ),
    );
    process.stdout.write(`\nWrote ${outFile}\n`);
  }

  process.exit(failed.length > 0 ? 1 : 0);
}

function statsOf(values: readonly (number | undefined)[]): Record<string, number> | null {
  const present = values.filter((v): v is number => v !== undefined);
  if (present.length === 0) return null;
  return {
    n: present.length,
    p50: Number(percentile(present, 50).toFixed(1)),
    p95: Number(percentile(present, 95).toFixed(1)),
    min: Number(Math.min(...present).toFixed(1)),
    max: Number(Math.max(...present).toFixed(1)),
  };
}

main().catch((error: unknown) => {
  process.stderr.write(`benchmark failed: ${String(error)}\n`);
  process.exit(1);
});
