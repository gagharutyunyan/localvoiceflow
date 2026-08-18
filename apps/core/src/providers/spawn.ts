import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { PipelineError } from "@lvf/shared";

/**
 * Environment variables that would flip a CLI from the user's subscription onto
 * metered API billing. In subscription-only mode they are removed from the child's
 * environment — their values are never read, logged or copied anywhere.
 */
export const API_KEY_ENV_VARS = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "CODEX_API_KEY",
  "AWS_BEARER_TOKEN_BEDROCK",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
] as const;

/** Names (never values) of API-key variables currently present in this process. */
export function detectApiKeyEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  return API_KEY_ENV_VARS.filter((name) => {
    const value = env[name];
    return typeof value === "string" && value.length > 0;
  });
}

/**
 * Builds the child environment for a subscription-only CLI invocation.
 * Deletion is unconditional: an unset variable cannot leak, and the CLI then has no
 * choice but to fall back to its stored OAuth credentials.
 */
export function subscriptionOnlyEnv(
  base: NodeJS.ProcessEnv,
  extra: Record<string, string> = {},
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  for (const name of API_KEY_ENV_VARS) delete env[name];
  return { ...env, ...extra };
}

export interface RunResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
}

export interface RunOptions {
  args: readonly string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** Written to the child's stdin and then closed. Never passed as an argument. */
  stdin?: string;
  timeoutMs: number;
  signal?: AbortSignal;
  maxOutputBytes?: number;
}

export interface StartOptions {
  args: readonly string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  maxOutputBytes?: number;
}

export interface FeedOptions {
  /** Written to the child's stdin and then closed. Never passed as an argument. */
  stdin?: string;
  timeoutMs: number;
  signal?: AbortSignal;
}

/**
 * A CLI child whose stdin has not been written yet. Lets a provider spawn the process
 * early (its startup overlaps other work) and feed it the payload once that exists —
 * the child cannot issue its request until stdin closes, so no quota is at risk while
 * it waits.
 */
export interface CliHandle {
  /** False once the child has exited or failed to spawn. */
  readonly alive: boolean;
  /**
   * Writes stdin, arms the timeout and the abort signal, and resolves like `runCli`.
   * Must be called at most once.
   */
  feed(options: FeedOptions): Promise<RunResult>;
  /** Kills the child's whole process group. Safe on a dead child and after feed(). */
  dispose(): void;
}

const DEFAULT_MAX_OUTPUT = 4 * 1024 * 1024;

/**
 * Spawns a CLI with an argv array and `shell: false`, deferring stdin to `feed()`.
 *
 * No string ever reaches a shell: user text goes over stdin, and every other value is a
 * separate argv element. `detached: true` puts the child in its own process group so a
 * cancellation can signal the whole tree (a CLI that spawned helpers of its own included)
 * rather than orphaning grandchildren.
 *
 * Throws `llm_cli_missing` when the spawn itself fails synchronously.
 */
export function startCli(command: string, options: StartOptions): CliHandle {
  const maxOutput = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT;
  const startedAt = process.hrtime.bigint();

  let child: ChildProcessWithoutNullStreams;
  try {
    child = spawn(command, [...options.args], {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (error) {
    throw new PipelineError("llm_cli_missing", `cannot start ${command}`, { cause: error });
  }

  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let settled = false;
  let timedOut = false;
  let exited = false;
  let timer: NodeJS.Timeout | undefined;
  let abortSignal: AbortSignal | undefined;

  let resolveResult!: (result: RunResult) => void;
  let rejectResult!: (error: Error) => void;
  const result = new Promise<RunResult>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });
  // A prewarmed child that is disposed unconsumed has no awaiter; without this detached
  // catch its rejection would surface as an unhandled rejection and crash the process.
  result.catch(() => {});

  const killTree = (signal: NodeJS.Signals) => {
    if (child.pid === undefined) return;
    try {
      // Negative pid targets the whole process group created by `detached: true`.
      process.kill(-child.pid, signal);
    } catch {
      try {
        child.kill(signal);
      } catch {
        /* already gone */
      }
    }
  };

  const settle = (fn: () => void) => {
    if (settled) return;
    settled = true;
    if (timer) clearTimeout(timer);
    abortSignal?.removeEventListener("abort", onAbort);
    fn();
  };

  // `close` waits for the stdio pipes, and a grandchild that escaped the process group
  // (setsid) can inherit them and never let go — SIGKILL on the group cannot reach it.
  // Once the kill escalation has run its course, settle the promise anyway: detach the
  // pipes and report a timeout, so the pipeline is never held open forever.
  const armFinalDeadline = (afterMs: number) => {
    setTimeout(() => {
      settle(() => {
        child.stdout.destroy();
        child.stderr.destroy();
        child.stdin.destroy();
        rejectResult(
          new PipelineError("llm_timeout", `${command} did not release its pipes after SIGKILL`),
        );
      });
    }, afterMs).unref();
  };

  const onAbort = () => {
    killTree("SIGTERM");
    setTimeout(() => killTree("SIGKILL"), 1000).unref();
    armFinalDeadline(3000);
  };

  child.stdout.on("data", (chunk: Buffer) => {
    stdoutBytes += chunk.length;
    if (stdoutBytes <= maxOutput) stdoutChunks.push(chunk);
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderrBytes += chunk.length;
    if (stderrBytes <= maxOutput) stderrChunks.push(chunk);
  });

  child.on("error", (error) => {
    exited = true;
    settle(() => {
      const code = (error as NodeJS.ErrnoException).code;
      rejectResult(
        code === "ENOENT"
          ? new PipelineError("llm_cli_missing", `${command} not found on PATH`, { cause: error })
          : new PipelineError("llm_failed", `${command} failed to start`, { cause: error }),
      );
    });
  });

  child.on("close", (code, signal) => {
    exited = true;
    settle(() =>
      resolveResult({
        code,
        signal,
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
        durationMs: Number(process.hrtime.bigint() - startedAt) / 1e6,
        timedOut,
      }),
    );
  });

  // stdin is written by feed(); the child may also exit before reading it (bad flag,
  // auth failure). EPIPE here is expected and the real diagnosis comes from the exit
  // code and stderr.
  child.stdin.on("error", () => {});

  return {
    get alive() {
      return !exited && !settled;
    },

    feed(feedOptions: FeedOptions): Promise<RunResult> {
      if (feedOptions.signal?.aborted) {
        // The awaits leading up to feed() (Esc during STT) may have fired the signal
        // already; an "abort" listener added now would never run. Kill and refuse.
        killTree("SIGTERM");
        setTimeout(() => killTree("SIGKILL"), 1000).unref();
        settle(() =>
          rejectResult(new PipelineError("cancelled", `${command} not fed: already cancelled`)),
        );
        return result;
      }

      if (!settled) {
        abortSignal = feedOptions.signal;
        abortSignal?.addEventListener("abort", onAbort, { once: true });

        timer = setTimeout(() => {
          timedOut = true;
          killTree("SIGTERM");
          // A CLI that ignores SIGTERM must not hold the pipeline open forever.
          setTimeout(() => killTree("SIGKILL"), 2000).unref();
          armFinalDeadline(4000);
        }, feedOptions.timeoutMs);
        timer.unref();
      }

      if (feedOptions.stdin !== undefined) {
        child.stdin.end(feedOptions.stdin, "utf8");
      } else {
        child.stdin.end();
      }
      return result;
    },

    dispose(): void {
      if (exited) return;
      killTree("SIGTERM");
      setTimeout(() => killTree("SIGKILL"), 1000).unref();
      // No armFinalDeadline: nobody awaits a disposed child, so a wedged pipe holds
      // nothing open; `close` (or process exit) reaps it.
    },
  };
}

/**
 * Runs a CLI to completion: `startCli` + immediate `feed`. The historical entry point;
 * everything that has its stdin ready up front uses this.
 */
export function runCli(command: string, options: RunOptions): Promise<RunResult> {
  // An "abort" listener added to an already-fired signal never runs, so a signal
  // aborted before this call (Esc or shutdown during the awaits leading up to the
  // spawn) would leave the child running unsupervised — burning quota and outliving
  // the process. Refuse to spawn at all instead.
  if (options.signal?.aborted) {
    return Promise.reject(
      new PipelineError("cancelled", `${command} not started: already cancelled`),
    );
  }

  let handle: CliHandle;
  try {
    handle = startCli(command, {
      args: options.args,
      cwd: options.cwd,
      env: options.env,
      ...(options.maxOutputBytes !== undefined ? { maxOutputBytes: options.maxOutputBytes } : {}),
    });
  } catch (error) {
    return Promise.reject(error);
  }

  return handle.feed({
    ...(options.stdin !== undefined ? { stdin: options.stdin } : {}),
    timeoutMs: options.timeoutMs,
    ...(options.signal ? { signal: options.signal } : {}),
  });
}
