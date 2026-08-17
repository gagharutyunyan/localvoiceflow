import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  CORRECTION_JSON_SCHEMA,
  CorrectionOutputSchema,
  PipelineError,
  serializeCorrectionPayload,
  type CorrectionInput,
  type CorrectionResult,
  type ProviderConfig,
  type ProviderHealth,
  type TextCorrectionProvider,
} from "@lvf/shared";
import { detectApiKeyEnv, runCli, subscriptionOnlyEnv } from "./spawn.js";
import { classifyCliFailure, summarizeStderr } from "./errors.js";
import { resolveExecutable } from "./which.js";

export interface CodexArgsOptions {
  model: string;
  effort: string;
  workDir: string;
  schemaFile: string;
  outputFile: string;
}

/**
 * Builds the argv array for `codex exec`.
 *
 * Verified against codex-cli 0.147.0: `--ask-for-approval` does not exist on the `exec`
 * subcommand (exec already runs with `approval: never`), so it is deliberately absent.
 * The prompt is `-` — Codex then reads it from stdin, keeping dictated text out of argv.
 */
export function buildCodexArgs(options: CodexArgsOptions): string[] {
  return [
    "exec",
    "-m",
    options.model,
    "-c",
    `model_reasoning_effort="${options.effort}"`,
    // No web search: the task is text editing, and a search would leak the dictation.
    "-c",
    "tools.web_search=false",
    "--sandbox",
    "read-only",
    "--skip-git-repo-check",
    // Do not persist a session, and do not read the user's config.toml — auth still works.
    "--ephemeral",
    "--ignore-user-config",
    "--ignore-rules",
    "--color",
    "never",
    "-C",
    options.workDir,
    "--output-schema",
    options.schemaFile,
    "-o",
    options.outputFile,
    "-",
  ];
}

/**
 * Reads the corrected text.
 *
 * The `-o` file is authoritative: it holds only the model's final message. Codex also
 * echoes a transcript on stdout, so stdout is used only when the file is missing —
 * and even then the parse is strict rather than scraping the banner.
 */
export function parseCodexOutput(fileContents: string | undefined, stdout: string): string {
  const candidates = [fileContents, extractLastJsonObject(stdout)];

  for (const candidate of candidates) {
    if (!candidate) continue;
    const trimmed = candidate.trim();
    if (trimmed.length === 0) continue;
    try {
      const parsed = CorrectionOutputSchema.safeParse(JSON.parse(trimmed));
      if (parsed.success) return parsed.data.text;
    } catch {
      // Fall through to the next candidate.
    }
  }

  throw new PipelineError("llm_invalid_output", "codex returned no valid structured output");
}

/** Finds the last balanced top-level JSON object in a text stream. */
function extractLastJsonObject(text: string): string | undefined {
  let depth = 0;
  let start = -1;
  let last: string | undefined;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "{") {
      if (depth === 0) start = i;
      depth += 1;
      continue;
    }
    if (ch === "}") {
      depth -= 1;
      if (depth === 0 && start >= 0) last = text.slice(start, i + 1);
      if (depth < 0) depth = 0;
    }
  }
  return last;
}

/**
 * Reads the outcome of `codex login status`.
 *
 * The CLI prints "Logged in using ChatGPT" on **stderr**, not stdout. An earlier version
 * inspected stdout alone, so the health check reported "not signed in" for a CLI that was
 * perfectly authenticated and the provider refused every request. Both streams are
 * considered here; no account identifier is extracted from either.
 */
export function parseCodexLoginStatus(run: {
  code: number | null;
  stdout: string;
  stderr: string;
}): { authenticated: boolean; detail: string } {
  const text = `${run.stdout}\n${run.stderr}`.trim();
  const authenticated = run.code === 0 && /logged in/i.test(text);
  if (!authenticated) return { authenticated: false, detail: "not logged in" };
  return {
    authenticated: true,
    detail: /chatgpt/i.test(text) ? "ChatGPT subscription" : "logged in",
  };
}

export class CodexCliProvider implements TextCorrectionProvider {
  readonly id = "openai-codex-cli" as const;

  readonly #workDir: string;
  #cachedHealth: { at: number; value: ProviderHealth } | undefined;

  constructor(options: { workDir: string }) {
    this.#workDir = options.workDir;
  }

  async health(): Promise<ProviderHealth> {
    const cached = this.#cachedHealth;
    if (cached && Date.now() - cached.at < 15_000) return cached.value;

    const apiKeyEnvPresent = detectApiKeyEnv();
    const cliPath = await resolveExecutable("codex");

    if (!cliPath) {
      const value: ProviderHealth = {
        id: this.id,
        available: false,
        authenticated: false,
        apiKeyEnvPresent,
        missingFlags: [],
        error: "codex CLI not found on PATH",
      };
      this.#cachedHealth = { at: Date.now(), value };
      return value;
    }

    const env = subscriptionOnlyEnv(process.env);
    let version: string | undefined;
    let authenticated = false;
    let authDetail: string | undefined;
    let error: string | undefined;

    try {
      const versionRun = await runCli(cliPath, {
        args: ["--version"],
        cwd: this.#workDir,
        env,
        timeoutMs: 15_000,
      });
      version = versionRun.stdout.trim() || undefined;
    } catch (versionError) {
      error = `version probe failed: ${String(versionError)}`;
    }

    try {
      const loginRun = await runCli(cliPath, {
        args: ["login", "status"],
        cwd: this.#workDir,
        env,
        timeoutMs: 20_000,
      });
      const status = parseCodexLoginStatus(loginRun);
      authenticated = status.authenticated;
      authDetail = status.detail;
    } catch (loginError) {
      authDetail = "could not determine login status";
      error ??= String(loginError);
    }

    const missingFlags = await this.#detectMissingFlags(cliPath, env);

    const value: ProviderHealth = {
      id: this.id,
      available: true,
      cliPath,
      authenticated,
      apiKeyEnvPresent,
      missingFlags,
      ...(version ? { version } : {}),
      ...(authDetail ? { authDetail } : {}),
      ...(error ? { error } : {}),
    };
    this.#cachedHealth = { at: Date.now(), value };
    return value;
  }

  /** Reads `codex exec --help` once and checks the flags this adapter relies on. */
  async #detectMissingFlags(cliPath: string, env: NodeJS.ProcessEnv): Promise<string[]> {
    try {
      const help = await runCli(cliPath, {
        args: ["exec", "--help"],
        cwd: this.#workDir,
        env,
        timeoutMs: 15_000,
      });
      const text = help.stdout + help.stderr;
      return [
        "--output-schema",
        "--output-last-message",
        "--sandbox",
        "--skip-git-repo-check",
        "--ephemeral",
        "--ignore-user-config",
      ].filter((flag) => !text.includes(flag));
    } catch {
      return [];
    }
  }

  async correct(
    input: CorrectionInput,
    config: ProviderConfig,
    signal?: AbortSignal,
  ): Promise<CorrectionResult> {
    const cliPath = await resolveExecutable("codex");
    if (!cliPath) {
      throw new PipelineError("llm_cli_missing", "codex CLI not found on PATH");
    }

    const health = await this.health();
    if (!health.authenticated) {
      throw new PipelineError(
        "llm_not_authenticated",
        "Codex is not signed in — run `codex login`",
      );
    }

    // A private temp dir per call, removed in `finally`, so a concurrent dictation can
    // never read or overwrite another one's output file.
    const scratch = mkdtempSync(join(tmpdir(), "lvf-codex-"));
    const schemaFile = join(scratch, "schema.json");
    const outputFile = join(scratch, "output.json");
    writeFileSync(schemaFile, JSON.stringify(CORRECTION_JSON_SCHEMA), {
      encoding: "utf8",
      mode: 0o600,
    });

    try {
      const args = buildCodexArgs({
        model: config.model,
        effort: config.effort,
        workDir: this.#workDir,
        schemaFile,
        outputFile,
      });

      // Codex has no system-prompt flag, so the instructions lead the single user
      // message and the data follows, clearly framed as data.
      const payload = serializeCorrectionPayload(input);
      const stdin = `${config.systemPrompt}\n\n---\n\n${payload.text}\n`;

      const startedAt = process.hrtime.bigint();
      const run = await runCli(cliPath, {
        args,
        cwd: this.#workDir,
        env: subscriptionOnlyEnv(process.env, { RUST_LOG: "error" }),
        stdin,
        timeoutMs: config.timeoutMs,
        ...(signal ? { signal } : {}),
      });
      const latencyMs = Number(process.hrtime.bigint() - startedAt) / 1e6;

      if (signal?.aborted) {
        throw new PipelineError("cancelled", "correction cancelled");
      }
      if (run.timedOut) {
        throw new PipelineError("llm_timeout", `codex timed out after ${config.timeoutMs} ms`);
      }
      if (run.code !== 0) {
        throw classifyCliFailure(run.stderr, run.stdout, run.code, run.timedOut);
      }

      let fileContents: string | undefined;
      try {
        fileContents = readFileSync(outputFile, "utf8");
      } catch {
        fileContents = undefined;
      }

      const finalText = parseCodexOutput(fileContents, run.stdout);

      const warnings: string[] = [];
      if (health.apiKeyEnvPresent.length > 0) {
        warnings.push(
          `${health.apiKeyEnvPresent.join(", ")} present in the environment; removed for this call`,
        );
      }
      const stderrSummary = summarizeStderr(run.stderr, 200);
      if (stderrSummary.length > 0) warnings.push(stderrSummary);

      return {
        finalText,
        provider: this.id,
        model: config.model,
        effort: config.effort,
        latencyMs,
        metadata: { cliDurationMs: Math.round(run.durationMs) },
        warnings,
      };
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }
}
