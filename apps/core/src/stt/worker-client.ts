import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { createInterface, type Interface } from "node:readline";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { PipelineError, type SttHealth, type SttInput, type SttProvider, type SttResult } from "@lvf/shared";
import type { Logger } from "../logger.js";

interface PendingRequest {
  resolve: (value: Record<string, unknown>) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  op: string;
}

export interface SttWorkerOptions {
  /** Absolute path to the venv python that has mlx-whisper installed. */
  pythonPath: string;
  /** Directory containing the `lvf_stt` package. */
  workerDir: string;
  model: string;
  warmUp: boolean;
  logger: Logger;
  requestTimeoutMs?: number;
  /** Injectable for tests; defaults to `spawn`. */
  spawnFn?: typeof spawn;
}

const BACKOFF_MS = [1000, 2000, 4000, 8000, 16000, 30000];

/**
 * Supervises the persistent Python STT worker.
 *
 * The model costs seconds to load and 1.6 GB of memory, so exactly one process is kept
 * alive for the lifetime of core. If it dies, in-flight requests fail fast with
 * `stt_unavailable` and a restart is scheduled with backoff — a crash loop must not turn
 * into a spawn storm.
 */
export class SttWorkerClient extends EventEmitter implements SttProvider {
  #options: SttWorkerOptions;
  #child: ChildProcessWithoutNullStreams | undefined;
  #rl: Interface | undefined;
  #pending = new Map<string, PendingRequest>();
  #health: SttHealth;
  #restarts = 0;
  #restartTimer: NodeJS.Timeout | undefined;
  #stopping = false;

  constructor(options: SttWorkerOptions) {
    super();
    this.#options = options;
    this.#health = {
      ready: false,
      state: "stopped",
      backend: "mlx-whisper",
      model: options.model,
      restarts: 0,
    };
  }

  get currentHealth(): SttHealth {
    return { ...this.#health, restarts: this.#restarts };
  }

  /** Applies a settings change; a different model requires a restart to take effect. */
  reconfigure(options: Partial<Pick<SttWorkerOptions, "model" | "warmUp" | "pythonPath">>): boolean {
    const modelChanged = options.model !== undefined && options.model !== this.#options.model;
    const pythonChanged =
      options.pythonPath !== undefined && options.pythonPath !== this.#options.pythonPath;
    this.#options = { ...this.#options, ...options };
    if (modelChanged || pythonChanged) {
      this.#health = { ...this.#health, model: this.#options.model };
      void this.restart();
      return true;
    }
    return false;
  }

  start(): void {
    if (this.#child || this.#stopping) return;

    const { pythonPath, workerDir, model, warmUp, logger } = this.#options;

    if (!existsSync(pythonPath)) {
      this.#setHealth({
        ready: false,
        state: "error",
        error: `python interpreter not found at ${pythonPath} — run \`make bootstrap\``,
      });
      return;
    }

    const args = ["-m", "lvf_stt", "--model", model];
    if (!warmUp) args.push("--no-warmup");

    logger.info("stt worker starting", { model, restarts: this.#restarts });
    this.#setHealth({ ready: false, state: "starting" });

    const spawnFn = this.#options.spawnFn ?? spawn;
    const child = spawnFn(pythonPath, args, {
      cwd: workerDir,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        PYTHONPATH: workerDir,
        PYTHONUNBUFFERED: "1",
        // Keeps the HF cache in the user's standard location and out of the repo.
        HF_HUB_DISABLE_PROGRESS_BARS: "1",
      },
    }) as ChildProcessWithoutNullStreams;

    this.#child = child;

    this.#rl = createInterface({ input: child.stdout });
    this.#rl.on("line", (line) => this.#onLine(line));

    child.stderr.on("data", (chunk: Buffer) => {
      for (const line of chunk.toString("utf8").split("\n")) {
        const trimmed = line.trim();
        if (trimmed.length > 0) logger.debug("stt worker log", { line: trimmed.slice(0, 400) });
      }
    });

    child.on("error", (error) => {
      logger.error("stt worker spawn error", { error: String(error) });
      this.#setHealth({ ready: false, state: "error", error: String(error) });
    });

    child.on("exit", (code, signal) => {
      const wasStopping = this.#stopping;
      this.#child = undefined;
      this.#rl?.close();
      this.#rl = undefined;
      this.#failAllPending(
        new PipelineError("stt_unavailable", `stt worker exited (code ${code ?? "null"})`),
      );
      if (wasStopping) {
        this.#setHealth({ ready: false, state: "stopped" });
        return;
      }
      logger.warn("stt worker exited unexpectedly", { code, signal, restarts: this.#restarts });
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

    // Ask politely first so the worker can flush; escalate if it does not go.
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
      // stdout is protocol-only by contract; anything else means a library printed to
      // the wrong stream. Log it and keep going rather than killing the worker.
      this.#options.logger.warn("stt worker wrote non-JSON to stdout", {
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
      const code = typeof message.error_code === "string" ? message.error_code : "stt_failed";
      const detail = typeof message.error === "string" ? message.error : "stt worker error";
      pending.reject(
        new PipelineError(
          code === "cancelled" ? "cancelled" : code === "audio_invalid" ? "audio_invalid" : "stt_failed",
          detail,
        ),
      );
      return;
    }

    pending.resolve(message);
  }

  #onStatusEvent(message: Record<string, unknown>): void {
    if (message.op !== "status") return;
    const state = typeof message.state === "string" ? message.state : "starting";
    const patch: Partial<SttHealth> = {
      ready: message.ready === true,
      state: state as SttHealth["state"],
    };
    if (typeof message.model === "string") patch.model = message.model;
    if (typeof message.device === "string") patch.device = message.device;
    if (typeof message.load_ms === "number") patch.loadMs = message.load_ms;
    if (typeof message.warmed_up === "boolean") patch.warmedUp = message.warmed_up;
    if (typeof message.error === "string") patch.error = message.error;
    else if (patch.state === "ready") patch.error = undefined;

    if (patch.state === "ready") this.#restarts = Math.max(0, this.#restarts);
    this.#setHealth(patch);
  }

  #setHealth(patch: Partial<SttHealth>): void {
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
        new PipelineError("stt_unavailable", "the speech-to-text worker is not running"),
      );
    }

    const id = String(payload.id ?? randomUUID());
    payload.id = id;

    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        this.#cancelRemote(id);
        reject(new PipelineError("stt_timeout", `stt request timed out after ${timeoutMs} ms`));
      }, timeoutMs);
      timer.unref();

      const onAbort = () => {
        this.#pending.delete(id);
        clearTimeout(timer);
        this.#cancelRemote(id);
        reject(new PipelineError("cancelled", "transcription cancelled"));
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
        reject(new PipelineError("stt_unavailable", "could not write to the stt worker", { cause: error }));
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

  async health(): Promise<SttHealth> {
    if (!this.#child) return this.currentHealth;
    try {
      const response = await this.#send({ op: "health" }, 5000);
      const patch: Partial<SttHealth> = {
        ready: response.ready === true,
        state: (typeof response.state === "string" ? response.state : "ready") as SttHealth["state"],
      };
      if (typeof response.model === "string") patch.model = response.model;
      if (typeof response.device === "string") patch.device = response.device;
      if (typeof response.load_ms === "number") patch.loadMs = response.load_ms;
      if (typeof response.warmed_up === "boolean") patch.warmedUp = response.warmed_up;
      this.#setHealth(patch);
    } catch {
      // A failed health probe is itself the answer; the cached state already says so.
    }
    return this.currentHealth;
  }

  async transcribe(input: SttInput, signal?: AbortSignal): Promise<SttResult> {
    if (!this.#child) {
      throw new PipelineError("stt_unavailable", "the speech-to-text worker is not running");
    }
    if (!this.#health.ready) {
      throw new PipelineError(
        "stt_unavailable",
        `the speech-to-text model is not ready (${this.#health.state})`,
      );
    }

    const response = await this.#send(
      {
        id: input.requestId,
        op: "transcribe",
        audio_path: input.audioPath,
        language: input.language,
        initial_prompt: input.initialPrompt ?? "",
      },
      this.#options.requestTimeoutMs ?? 120_000,
      signal,
    );

    return {
      rawTranscript: typeof response.raw_transcript === "string" ? response.raw_transcript : "",
      ...(typeof response.detected_language === "string"
        ? { detectedLanguage: response.detected_language }
        : {}),
      audioDurationMs: typeof response.audio_duration_ms === "number" ? response.audio_duration_ms : 0,
      transcriptionMs: typeof response.transcription_ms === "number" ? response.transcription_ms : 0,
      model: typeof response.model === "string" ? response.model : this.#options.model,
      noSpeech: response.no_speech === true,
      warnings: Array.isArray(response.warnings)
        ? response.warnings.filter((w): w is string => typeof w === "string")
        : [],
    };
  }
}

/** Default location of the venv interpreter created by `make bootstrap`. */
export function defaultWorkerPython(repoRoot: string): string {
  return join(repoRoot, "services", "stt-worker", ".venv", "bin", "python");
}

export function defaultWorkerDir(repoRoot: string): string {
  return join(repoRoot, "services", "stt-worker");
}
