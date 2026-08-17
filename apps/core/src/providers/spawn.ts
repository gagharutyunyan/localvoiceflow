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

const DEFAULT_MAX_OUTPUT = 4 * 1024 * 1024;

/**
 * Runs a CLI with an argv array and `shell: false`.
 *
 * No string ever reaches a shell: user text goes over stdin, and every other value is a
 * separate argv element. `detached: true` puts the child in its own process group so a
 * cancellation can signal the whole tree (a CLI that spawned helpers of its own included)
 * rather than orphaning grandchildren.
 */
export function runCli(command: string, options: RunOptions): Promise<RunResult> {
  const maxOutput = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT;

  return new Promise<RunResult>((resolve, reject) => {
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
      reject(new PipelineError("llm_cli_missing", `cannot start ${command}`, { cause: error }));
      return;
    }

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    let timedOut = false;

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

    const timer = setTimeout(() => {
      timedOut = true;
      killTree("SIGTERM");
      // A CLI that ignores SIGTERM must not hold the pipeline open forever.
      setTimeout(() => killTree("SIGKILL"), 2000).unref();
    }, options.timeoutMs);
    timer.unref();

    const onAbort = () => {
      killTree("SIGTERM");
      setTimeout(() => killTree("SIGKILL"), 1000).unref();
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });

    const finish = (result: RunResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      resolve(result);
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
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      const code = (error as NodeJS.ErrnoException).code;
      reject(
        code === "ENOENT"
          ? new PipelineError("llm_cli_missing", `${command} not found on PATH`, { cause: error })
          : new PipelineError("llm_failed", `${command} failed to start`, { cause: error }),
      );
    });

    child.on("close", (code, signal) => {
      finish({
        code,
        signal,
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
        durationMs: Number(process.hrtime.bigint() - startedAt) / 1e6,
        timedOut,
      });
    });

    if (options.stdin !== undefined) {
      child.stdin.on("error", () => {
        // The child may exit before reading stdin (bad flag, auth failure); EPIPE here
        // is expected and the real diagnosis comes from the exit code and stderr.
      });
      child.stdin.end(options.stdin, "utf8");
    } else {
      child.stdin.end();
    }
  });
}
