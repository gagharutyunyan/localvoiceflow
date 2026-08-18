import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
import { detectApiKeyEnv, runCli, startCli, subscriptionOnlyEnv, type CliHandle, type RunResult } from "./spawn.js";
import { classifyCliFailure, summarizeStderr } from "./errors.js";
import { resolveExecutable } from "./which.js";

/**
 * Flags this adapter depends on. Verified present in Claude Code 2.1.234 by invoking the
 * CLI — `--max-turns`, `--system-prompt-file` and `--append-system-prompt-file` are
 * accepted even though they are absent from `--help` output.
 */
const REQUIRED_FLAGS = [
  "--print",
  "--model",
  "--effort",
  "--output-format",
  "--json-schema",
  "--no-session-persistence",
  "--tools",
  "--disallowed-tools",
  "--safe-mode",
  "--setting-sources",
  "--strict-mcp-config",
] as const;

const HIDDEN_FLAGS = ["--max-turns", "--system-prompt-file"] as const;

export interface ClaudeArgsOptions {
  model: string;
  effort: string;
  systemPromptFile: string;
  /** Degrade gracefully when an installed CLI lacks a flag. */
  supportedFlags?: ReadonlySet<string>;
}

/**
 * Builds the argv array.
 *
 * Two things are deliberate and load-bearing:
 *  - The user payload is NOT here. It goes over stdin, so no dictated text can ever be
 *    mistaken for a flag or reach a shell.
 *  - `--tools ""` is variadic in commander, so it is never the last element before a
 *    positional; keeping it in the middle means the empty string cannot swallow anything.
 */
export function buildClaudeArgs(options: ClaudeArgsOptions): string[] {
  const supported = options.supportedFlags;
  const has = (flag: string): boolean => supported === undefined || supported.has(flag);

  const args: string[] = ["-p"];

  args.push("--model", options.model);
  if (has("--effort")) args.push("--effort", options.effort);
  args.push("--output-format", "json");
  if (has("--json-schema")) args.push("--json-schema", JSON.stringify(CORRECTION_JSON_SCHEMA));
  if (has("--no-session-persistence")) args.push("--no-session-persistence");
  if (has("--max-turns")) args.push("--max-turns", "1");
  // Isolates the run from the user's CLAUDE.md, skills, plugins, hooks and MCP servers
  // while leaving subscription auth intact (confirmed by smoke test).
  if (has("--safe-mode")) args.push("--safe-mode");
  if (has("--setting-sources")) args.push("--setting-sources", "");
  if (has("--strict-mcp-config")) args.push("--strict-mcp-config");
  if (has("--system-prompt-file")) args.push("--system-prompt-file", options.systemPromptFile);
  if (has("--disallowed-tools")) args.push("--disallowed-tools", "mcp__*");
  if (has("--tools")) args.push("--tools", "");

  return args;
}

interface ClaudeJsonResult {
  is_error?: boolean;
  subtype?: string;
  result?: unknown;
  structured_output?: unknown;
  duration_ms?: number;
  duration_api_ms?: number;
  num_turns?: number;
  usage?: Record<string, unknown>;
  modelUsage?: Record<string, unknown>;
  total_cost_usd?: number;
  api_error_status?: unknown;
  permission_denials?: unknown[];
}

/**
 * Extracts the corrected text from the CLI's JSON envelope.
 *
 * `structured_output` is the contract when `--json-schema` is honoured. Older builds
 * return the JSON as a string in `result` instead, so that is parsed as a fallback —
 * and if even that is not JSON, a plain-text `result` is accepted rather than failing
 * the whole dictation over an envelope detail.
 */
export function parseClaudeOutput(stdout: string): { text: string; meta: ClaudeJsonResult } {
  const trimmed = stdout.trim();
  if (trimmed.length === 0) {
    throw new PipelineError("llm_invalid_output", "the CLI produced no output");
  }

  let envelope: ClaudeJsonResult;
  try {
    envelope = JSON.parse(trimmed) as ClaudeJsonResult;
  } catch {
    throw new PipelineError("llm_invalid_output", "the CLI output was not valid JSON");
  }

  if (envelope.is_error === true) {
    const detail = typeof envelope.result === "string" ? envelope.result : envelope.subtype;
    throw new PipelineError("llm_failed", `the CLI reported an error${detail ? `: ${detail}` : ""}`);
  }

  const structured = CorrectionOutputSchema.safeParse(envelope.structured_output);
  if (structured.success) {
    return { text: structured.data.text, meta: envelope };
  }

  if (typeof envelope.result === "string") {
    const raw = envelope.result.trim();
    try {
      const parsed = CorrectionOutputSchema.safeParse(JSON.parse(raw));
      if (parsed.success) return { text: parsed.data.text, meta: envelope };
    } catch {
      // Not JSON — fall through and take the text as-is.
    }
    if (raw.length > 0) return { text: raw, meta: envelope };
  }

  throw new PipelineError("llm_invalid_output", "the CLI returned no usable text");
}

/** CLI metadata worth keeping, with everything identifying or secret dropped. */
export function sanitizeClaudeMetadata(meta: ClaudeJsonResult): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (typeof meta.duration_ms === "number") out.durationMs = meta.duration_ms;
  if (typeof meta.duration_api_ms === "number") out.apiDurationMs = meta.duration_api_ms;
  if (typeof meta.num_turns === "number") out.numTurns = meta.num_turns;
  if (typeof meta.subtype === "string") out.subtype = meta.subtype;
  if (typeof meta.total_cost_usd === "number") out.costUsd = meta.total_cost_usd;
  return out;
}

/** A CLI child spawned ahead of its payload, plus everything needed to adopt or kill it. */
interface PrewarmedCli {
  handle: CliHandle;
  /** Everything that shaped the child's argv/env; a mismatch means "do not consume". */
  key: string;
  /** Holds the system prompt the child was pointed at; deleted with the slot. */
  promptDir: string;
  /** Backstop: a prewarmed child nobody consumed must not linger forever. */
  expiry: NodeJS.Timeout;
}

/** How long an unconsumed prewarmed child may wait for its transcript. */
const PREWARM_TTL_MS = 120_000;

export class ClaudeCliProvider implements TextCorrectionProvider {
  readonly id = "claude-cli" as const;

  readonly #workDir: string;
  #cachedHealth: { at: number; value: ProviderHealth } | undefined;
  #missingFlags: Promise<string[]> | undefined;
  #prewarmed: PrewarmedCli | undefined;
  /** Bumped by cancelPrewarm() so an async prewarm still in flight knows to self-destruct. */
  #prewarmGen = 0;

  constructor(options: { workDir: string }) {
    this.#workDir = options.workDir;
  }

  async health(): Promise<ProviderHealth> {
    // The two probes below spawn processes; caching keeps the dashboard's polling cheap.
    const cached = this.#cachedHealth;
    if (cached && Date.now() - cached.at < 15_000) return cached.value;

    const apiKeyEnvPresent = detectApiKeyEnv();
    const cliPath = await resolveExecutable("claude");

    if (!cliPath) {
      const value: ProviderHealth = {
        id: this.id,
        available: false,
        authenticated: false,
        apiKeyEnvPresent,
        missingFlags: [],
        error: "claude CLI not found on PATH",
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
      const authRun = await runCli(cliPath, {
        args: ["auth", "status"],
        cwd: this.#workDir,
        env,
        timeoutMs: 20_000,
      });
      // Only the boolean and the coarse method are read. The payload also carries an
      // email and an org id; those are never stored or surfaced.
      const parsed = JSON.parse(authRun.stdout.trim() || "{}") as {
        loggedIn?: boolean;
        authMethod?: string;
        subscriptionType?: string;
      };
      authenticated = parsed.loggedIn === true;
      if (authenticated) {
        const method = parsed.authMethod ?? "unknown";
        const plan = parsed.subscriptionType ? ` (${parsed.subscriptionType})` : "";
        authDetail = `${method}${plan}`;
      } else {
        authDetail = "not signed in";
      }
    } catch (authError) {
      authDetail = "could not determine auth status";
      error ??= String(authError);
    }

    const value: ProviderHealth = {
      id: this.id,
      available: true,
      cliPath,
      authenticated,
      apiKeyEnvPresent,
      missingFlags: await this.#missingFlagsOnce(cliPath, env),
      ...(version ? { version } : {}),
      ...(authDetail ? { authDetail } : {}),
      ...(error ? { error } : {}),
    };
    this.#cachedHealth = { at: Date.now(), value };
    return value;
  }

  /**
   * Flag support cannot change under a running core, and probing spawns five
   * subprocesses — so it happens at most once per process, lazily on first use.
   */
  #missingFlagsOnce(cliPath: string, env: NodeJS.ProcessEnv): Promise<string[]> {
    this.#missingFlags ??= this.#detectMissingFlags(cliPath, env);
    return this.#missingFlags;
  }

  /** Everything that shapes a child's argv and env; prewarm/consume must agree on it. */
  static #prewarmKey(config: ProviderConfig): string {
    return [config.model, config.effort, String(config.disableThinking), config.systemPrompt].join("\u0000");
  }

  /** The argv/env pair for one correction call; shared by the warm and cold paths. */
  #buildInvocation(
    config: ProviderConfig,
    promptFile: string,
    missingFlags: string[],
  ): { args: string[]; env: NodeJS.ProcessEnv } {
    const supported = new Set(
      [...REQUIRED_FLAGS, ...HIDDEN_FLAGS].filter((flag) => !missingFlags.includes(flag)),
    );
    const args = buildClaudeArgs({
      model: config.model,
      effort: config.effort,
      systemPromptFile: promptFile,
      supportedFlags: supported,
    });
    const extraEnv: Record<string, string> = {
      // Measured: removes ~4.5 s of thinking on a short phrase with no quality loss.
      ...(config.disableThinking ? { MAX_THINKING_TOKENS: "0" } : {}),
      DISABLE_AUTOUPDATER: "1",
      DISABLE_TELEMETRY: "1",
      DISABLE_ERROR_REPORTING: "1",
      DISABLE_NON_ESSENTIAL_MODEL_CALLS: "1",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    };
    return { args, env: subscriptionOnlyEnv(process.env, extraEnv) };
  }

  /**
   * Spawns the CLI now so its ~0.4 s startup overlaps transcription. The child blocks
   * reading stdin, so no request leaves and no quota is spent until correct() feeds it.
   * Best-effort: any failure here just means the real call spawns its own child.
   */
  prewarm(config: ProviderConfig): void {
    const key = ClaudeCliProvider.#prewarmKey(config);
    if (this.#prewarmed?.handle.alive && this.#prewarmed.key === key) return;
    this.cancelPrewarm();
    const gen = this.#prewarmGen;

    void (async () => {
      const cliPath = await resolveExecutable("claude");
      if (!cliPath) return;
      const missingFlags = await this.#missingFlagsOnce(cliPath, subscriptionOnlyEnv(process.env));

      const promptDir = mkdtempSync(join(tmpdir(), "lvf-claude-"));
      try {
        const promptFile = join(promptDir, "system-prompt.md");
        writeFileSync(promptFile, config.systemPrompt, { encoding: "utf8", mode: 0o600 });
        const invocation = this.#buildInvocation(config, promptFile, missingFlags);
        const handle = startCli(cliPath, {
          args: invocation.args,
          cwd: this.#workDir,
          env: invocation.env,
        });

        const slot: PrewarmedCli = {
          handle,
          key,
          promptDir,
          expiry: setTimeout(() => {
            if (this.#prewarmed === slot) this.cancelPrewarm();
          }, PREWARM_TTL_MS),
        };
        slot.expiry.unref();

        // cancelPrewarm() may have run while the awaits above were in flight, or a
        // competing prewarm may have landed first; a child nobody tracks must die now.
        if (gen !== this.#prewarmGen || this.#prewarmed !== undefined) {
          clearTimeout(slot.expiry);
          handle.dispose();
          rmSync(promptDir, { recursive: true, force: true });
          return;
        }
        this.#prewarmed = slot;
      } catch {
        rmSync(promptDir, { recursive: true, force: true });
      }
    })().catch(() => {});
  }

  cancelPrewarm(): void {
    this.#prewarmGen += 1;
    const slot = this.#prewarmed;
    if (!slot) return;
    this.#prewarmed = undefined;
    clearTimeout(slot.expiry);
    slot.handle.dispose();
    rmSync(slot.promptDir, { recursive: true, force: true });
  }

  /**
   * Hands over the prewarmed child when it is still alive and was built for exactly
   * this config; otherwise kills it, because a stale child would apply a stale prompt.
   * The caller owns the returned slot, its promptDir included.
   */
  #takePrewarmed(config: ProviderConfig): PrewarmedCli | undefined {
    const slot = this.#prewarmed;
    if (!slot) return undefined;
    if (!slot.handle.alive || slot.key !== ClaudeCliProvider.#prewarmKey(config)) {
      this.cancelPrewarm();
      return undefined;
    }
    this.#prewarmed = undefined;
    clearTimeout(slot.expiry);
    return slot;
  }

  /**
   * Probes flag support by running `claude <flag> --version`: commander rejects an
   * unknown option before doing any work, so this costs nothing and touches no quota.
   */
  async #detectMissingFlags(cliPath: string, env: NodeJS.ProcessEnv): Promise<string[]> {
    const missing: string[] = [];
    const probes: Array<[string, string[]]> = [
      ["--max-turns", ["--max-turns", "1"]],
      ["--system-prompt-file", ["--system-prompt-file", "/dev/null"]],
      ["--safe-mode", ["--safe-mode"]],
      ["--json-schema", ["--json-schema", "{}"]],
      ["--no-session-persistence", ["--no-session-persistence"]],
    ];

    for (const [flag, args] of probes) {
      try {
        const run = await runCli(cliPath, {
          args: [...args, "--version"],
          cwd: this.#workDir,
          env,
          timeoutMs: 10_000,
        });
        if (/unknown option/i.test(run.stderr)) missing.push(flag);
      } catch {
        // A probe that cannot run tells us nothing about the flag; stay quiet rather
        // than reporting a false "missing".
      }
    }
    return missing;
  }

  async correct(
    input: CorrectionInput,
    config: ProviderConfig,
    signal?: AbortSignal,
  ): Promise<CorrectionResult> {
    const cliPath = await resolveExecutable("claude");
    if (!cliPath) {
      throw new PipelineError("llm_cli_missing", "claude CLI not found on PATH");
    }

    // No health() here: it spawns up to seven subprocesses and would add seconds to
    // every dictation. Authentication is not pre-checked either — a signed-out CLI
    // fails the real call and classifyCliFailure maps that to llm_not_authenticated.
    const apiKeyEnvPresent = detectApiKeyEnv();

    const payload = serializeCorrectionPayload(input);

    // A prewarmed child already carries this exact config (argv, env and prompt file);
    // adopting it skips the CLI's ~0.4 s startup. Its promptDir becomes ours to delete.
    const consumed = this.#takePrewarmed(config);

    let promptDir: string;
    let runPromise: Promise<RunResult>;
    const startedAt = process.hrtime.bigint();

    if (consumed) {
      promptDir = consumed.promptDir;
      runPromise = consumed.handle.feed({
        stdin: payload.text,
        timeoutMs: config.timeoutMs,
        ...(signal ? { signal } : {}),
      });
    } else {
      const missingFlags = await this.#missingFlagsOnce(cliPath, subscriptionOnlyEnv(process.env));
      promptDir = mkdtempSync(join(tmpdir(), "lvf-claude-"));
      const promptFile = join(promptDir, "system-prompt.md");
      writeFileSync(promptFile, config.systemPrompt, { encoding: "utf8", mode: 0o600 });
      const invocation = this.#buildInvocation(config, promptFile, missingFlags);
      runPromise = runCli(cliPath, {
        args: invocation.args,
        cwd: this.#workDir,
        env: invocation.env,
        stdin: payload.text,
        timeoutMs: config.timeoutMs,
        ...(signal ? { signal } : {}),
      });
    }

    try {
      const run = await runPromise;

      const latencyMs = Number(process.hrtime.bigint() - startedAt) / 1e6;

      if (signal?.aborted) {
        throw new PipelineError("cancelled", "correction cancelled");
      }

      if (run.timedOut) {
        throw new PipelineError("llm_timeout", `claude timed out after ${config.timeoutMs} ms`);
      }

      if (run.code !== 0) {
        throw classifyCliFailure(run.stderr, run.stdout, run.code, run.timedOut);
      }

      const parsed = parseClaudeOutput(run.stdout);
      const warnings: string[] = [];
      if (apiKeyEnvPresent.length > 0) {
        warnings.push(
          `${apiKeyEnvPresent.join(", ")} present in the environment; removed for this call`,
        );
      }
      const stderrSummary = summarizeStderr(run.stderr, 200);
      if (stderrSummary.length > 0) warnings.push(stderrSummary);

      const result: CorrectionResult = {
        finalText: parsed.text,
        provider: this.id,
        model: config.model,
        effort: config.effort,
        latencyMs,
        metadata: sanitizeClaudeMetadata(parsed.meta),
        warnings,
      };
      if (parsed.meta.usage) result.usage = parsed.meta.usage;
      return result;
    } finally {
      rmSync(promptDir, { recursive: true, force: true });
    }
  }
}
