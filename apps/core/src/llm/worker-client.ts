import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { createInterface, type Interface } from "node:readline";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { PipelineError } from "@lvf/shared";
import type { Logger } from "../logger.js";

interface PendingRequest {
  resolve: (value: Record<string, unknown>) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  op: string;
}

export interface LlmWorkerHealth {
  ready: boolean;
  state: "starting" | "loading" | "ready" | "error" | "stopped";
  backend: "mlx-lm";
  model: string;
  loadMs?: number;
  /** True once the system-prompt KV cache is filled — corrections are fast from here. */
  warmedPrompt?: boolean;
  error?: string;
  restarts?: number;
}

export interface LlmCorrectResult {
  text: string;
  model: string;
  promptTokens: number;
  generationTokens: number;
  generationMs: number;
  finishReason: string;
}

export interface LlmWorkerOptions {
  /** Absolute path to the venv python that has mlx-lm installed. */
  pythonPath: string;
  /** Directory containing the `lvf_stt` package. */
  workerDir: string;
  model: string;
  logger: Logger;
  /** Injectable for tests; defaults to `spawn`. */
  spawnFn?: typeof spawn;
}

const BACKOFF_MS = [1000, 2000, 4000, 8000, 16000, 30000];

/**
 * Supervises the persistent local text-correction worker (`lvf_stt --role llm`).
 *
 * Same supervision contract as `SttWorkerClient`: exactly one process, restarts with
 * backoff, in-flight requests fail fast when it dies. Kept separate rather than
 * generalised — the protocols share a shape but not a schema, and the STT client is
 * load-bearing code that should not change to accommodate a sibling.
 */
export class LlmWorkerClient extends EventEmitter {
  #options: LlmWorkerOptions;
  #child: ChildProcessWithoutNullStreams | undefined;
  #rl: Interface | undefined;
  #pending = new Map<string, PendingRequest>();
  #health: LlmWorkerHealth;
  #restarts = 0;
  #restartTimer: NodeJS.Timeout | undefined;
  #stopping = false;

  constructor(options: LlmWorkerOptions) {
    super();
    this.#options = options;
    this.#health = {
      ready: false,
      state: "stopped",
      backend: "mlx-lm",
      model: options.model,
      restarts: 0,
    };
  }

  get currentHealth(): LlmWorkerHealth {
    return { ...this.#health, restarts: this.#restarts };
  }

  get isRunning(): boolean {
    return this.#child !== undefined;
  }

  /** Applies a settings change; a different model requires a restart to take effect. */
  reconfigure(options: Partial<Pick<LlmWorkerOptions, "model" | "pythonPath">>): boolean {
    const modelChanged = options.model !== undefined && options.model !== this.#options.model;
    const pythonChanged =
      options.pythonPath !== undefined && options.pythonPath !== this.#options.pythonPath;
    this.#options = { ...this.#options, ...options };
    if ((modelChanged || pythonChanged) && this.#child) {
      this.#health = { ...this.#health, model: this.#options.model };
      void this.restart();
      return true;
    }
    if (modelChanged) this.#health = { ...this.#health, model: this.#options.model };
    return false;
  }

  start(): void {
    if (this.#child || this.#stopping) return;

    const { pythonPath, workerDir, model, logger } = this.#options;

    if (!existsSync(pythonPath)) {
      this.#setHealth({
        ready: false,
        state: "error",
        error: `python interpreter not found at ${pythonPath} — run \`make bootstrap\``,
      });
      return;
    }

    logger.info("llm worker starting", { model, restarts: this.#restarts });
    this.#setHealth({ ready: false, state: "starting" });

    const spawnFn = this.#options.spawnFn ?? spawn;
    const child = spawnFn(pythonPath, ["-m", "lvf_stt", "--role", "llm", "--model", model], {
      cwd: workerDir,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        PYTHONPATH: workerDir,
        PYTHONUNBUFFERED: "1",
        HF_HUB_DISABLE_PROGRESS_BARS: "1",
      },
    }) as ChildProcessWithoutNullStreams;

    this.#child = child;

    this.#rl = createInterface({ input: child.stdout });
    this.#rl.on("line", (line) => this.#onLine(line));

    child.stderr.on("data", (chunk: Buffer) => {
      for (const line of chunk.toString("utf8").split("\n")) {
        const trimmed = line.trim();
        if (trimmed.length > 0) logger.debug("llm worker log", { line: trimmed.slice(0, 400) });
      }
    });

    child.on("error", (error) => {
      logger.error("llm worker spawn error", { error: String(error) });
      this.#setHealth({ ready: false, state: "error", error: String(error) });
    });

    child.on("exit", (code, signal) => {
      const wasStopping = this.#stopping;
      this.#child = undefined;
      this.#rl?.close();
      this.#rl = undefined;
      this.#failAllPending(
        new PipelineError("llm_failed", `llm worker exited (code ${code ?? "null"})`),
      );
      if (wasStopping) {
        this.#setHealth({ ready: false, state: "stopped" });
        return;
      }
      logger.warn("llm worker exited unexpectedly", { code, signal, restarts: this.#restarts });
      this.#setHealth({
        ready: false,
        state: "error",
        error: `worker exited (code ${code ?? "null"}${signal ? `, signal ${signal}` : ""})`,
      });
      this.#scheduleRestart();
    });
  }

  #scheduleRestart(): void {
    if (this.#stopping || this.#restartTimer) return;
    const delay = BACKOFF_MS[Math.min(this.#restarts, BACKOFF_MS.length - 1)]!;
    this.#restarts += 1;
    this.#restartTimer = setTimeout(() => {
      this.#restartTimer = undefined;
      this.start();
    }, delay);
    this.#restartTimer.unref();
  }

  async restart(): Promise<void> {
    await this.stop();
    this.#stopping = false;
    this.#restarts = 0;
    this.start();
  }

  async stop(): Promise<void> {
    this.#stopping = true;
    if (this.#restartTimer) {
      clearTimeout(this.#restartTimer);
      this.#restartTimer = undefined;
    }
    const child = this.#child;
    if (!child) {
      this.#setHealth({ ready: false, state: "stopped" });
      return;
    }

    try {
      child.stdin.write(`${JSON.stringify({ id: randomUUID(), op: "shutdown" })}\n`);
    } catch {
      /* pipe already closed */
    }

    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          /* already gone */
        }
        resolve();
      }, 3000);
      timer.unref();
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
      try {
        child.kill("SIGTERM");
      } catch {
        clearTimeout(timer);
        resolve();
      }
    });

    this.#child = undefined;
    this.#setHealth({ ready: false, state: "stopped" });
  }

  #onLine(line: string): void {
    const trimmed = line.trim();
    if (trimmed.length === 0) return;

    let message: Record<string, unknown>;
    try {
      message = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      this.#options.logger.warn("llm worker wrote non-JSON to stdout", {
        preview: trimmed.slice(0, 200),
      });
      return;
    }

    const id = message.id;

    if (id === null || id === undefined) {
      this.#onStatusEvent(message);
      return;
    }

    const pending = this.#pending.get(String(id));
    if (!pending) return;
    this.#pending.delete(String(id));
    clearTimeout(pending.timer);

    if (message.ok === false) {
      const code = typeof message.error_code === "string" ? message.error_code : "llm_failed";
      const detail = typeof message.error === "string" ? message.error : "llm worker error";
      pending.reject(
        new PipelineError(code === "cancelled" ? "cancelled" : "llm_failed", detail),
      );
      return;
    }

    pending.resolve(message);
  }

  #onStatusEvent(message: Record<string, unknown>): void {
    if (message.op !== "status") return;
    const state = typeof message.state === "string" ? message.state : "starting";
    const patch: Partial<LlmWorkerHealth> = {
      ready: message.ready === true,
      state: state as LlmWorkerHealth["state"],
    };
    if (typeof message.model === "string") patch.model = message.model;
    if (typeof message.load_ms === "number") patch.loadMs = message.load_ms;
    if (typeof message.warmed_prompt === "boolean") patch.warmedPrompt = message.warmed_prompt;
    if (typeof message.error === "string") patch.error = message.error;
    else if (patch.state === "ready") patch.error = undefined;
    this.#setHealth(patch);
  }

  #setHealth(patch: Partial<LlmWorkerHealth>): void {
    this.#health = { ...this.#health, ...patch, restarts: this.#restarts };
    this.emit("health", this.currentHealth);
  }

  #failAllPending(error: Error): void {
    for (const [, pending] of this.#pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
  }

  #send(
    payload: Record<string, unknown>,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const child = this.#child;
    if (!child || child.stdin.destroyed) {
      return Promise.reject(
        new PipelineError("llm_failed", "the local correction worker is not running"),
      );
    }

    const id = String(payload.id ?? randomUUID());
    payload.id = id;

    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        this.#cancelRemote(id);
        reject(new PipelineError("llm_timeout", `llm request timed out after ${timeoutMs} ms`));
      }, timeoutMs);
      timer.unref();

      const onAbort = () => {
        this.#pending.delete(id);
        clearTimeout(timer);
        this.#cancelRemote(id);
        reject(new PipelineError("cancelled", "correction cancelled"));
      };
      signal?.addEventListener("abort", onAbort, { once: true });

      this.#pending.set(id, {
        op: String(payload.op),
        timer,
        resolve: (value) => {
          signal?.removeEventListener("abort", onAbort);
          resolve(value);
        },
        reject: (error) => {
          signal?.removeEventListener("abort", onAbort);
          reject(error);
        },
      });

      try {
        child.stdin.write(`${JSON.stringify(payload)}\n`);
      } catch (error) {
        this.#pending.delete(id);
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        reject(
          new PipelineError("llm_failed", "could not write to the llm worker", { cause: error }),
        );
      }
    });
  }

  #cancelRemote(targetId: string): void {
    const child = this.#child;
    if (!child || child.stdin.destroyed) return;
    try {
      child.stdin.write(
        `${JSON.stringify({ id: randomUUID(), op: "cancel", target_id: targetId })}\n`,
      );
    } catch {
      /* the worker is going away anyway */
    }
  }

  async health(): Promise<LlmWorkerHealth> {
    if (!this.#child) return this.currentHealth;
    try {
      const response = await this.#send({ op: "health" }, 5000);
      const patch: Partial<LlmWorkerHealth> = {
        ready: response.ready === true,
        state: (typeof response.state === "string"
          ? response.state
          : "ready") as LlmWorkerHealth["state"],
      };
      if (typeof response.model === "string") patch.model = response.model;
      if (typeof response.load_ms === "number") patch.loadMs = response.load_ms;
      if (typeof response.warmed_prompt === "boolean") patch.warmedPrompt = response.warmed_prompt;
      this.#setHealth(patch);
    } catch {
      // A failed probe is itself the answer; the cached state already says so.
    }
    return this.currentHealth;
  }

  /**
   * Pre-fills the system-prompt KV cache. Idempotent on the worker side, so it is
   * sent on every ready transition and settings change. Never throws — a failed warm
   * only costs the first correction a few seconds.
   */
  async warm(systemPrompt: string): Promise<void> {
    try {
      await this.#send({ op: "warm", system_prompt: systemPrompt }, 60_000);
    } catch (error) {
      this.#options.logger.warn("llm warm failed", { error: String(error) });
    }
  }

  async correct(
    input: { systemPrompt: string; payload: string; requestId?: string },
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<LlmCorrectResult> {
    if (!this.#child) {
      throw new PipelineError("llm_failed", "the local correction worker is not running");
    }

    const response = await this.#send(
      {
        ...(input.requestId ? { id: input.requestId } : {}),
        op: "correct",
        system_prompt: input.systemPrompt,
        payload: input.payload,
      },
      timeoutMs,
      signal,
    );

    return {
      text: typeof response.text === "string" ? response.text : "",
      model: typeof response.model === "string" ? response.model : this.#options.model,
      promptTokens: typeof response.prompt_tokens === "number" ? response.prompt_tokens : 0,
      generationTokens:
        typeof response.generation_tokens === "number" ? response.generation_tokens : 0,
      generationMs: typeof response.generation_ms === "number" ? response.generation_ms : 0,
      finishReason: typeof response.finish_reason === "string" ? response.finish_reason : "stop",
    };
  }
}
