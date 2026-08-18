import { createWriteStream, existsSync, mkdirSync, renameSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { WriteStream } from "node:fs";

export type LogLevel = "error" | "warn" | "info" | "debug";

const LEVEL_ORDER: Record<LogLevel, number> = { error: 0, warn: 1, info: 2, debug: 3 };

const MAX_BYTES = 5 * 1024 * 1024;
const MAX_FILES = 5;

/**
 * The write side of logging, shared by a logger and all of its children so that
 * rotation and level changes apply everywhere at once.
 */
class LogSink {
  level: LogLevel;
  readonly echo: boolean;
  readonly file: string | undefined;
  stream: WriteStream | undefined;

  constructor(level: LogLevel, echo: boolean, file: string | undefined) {
    this.level = level;
    this.echo = echo;
    this.file = file;
    if (file) {
      this.rotateIfNeeded();
      this.stream = createWriteStream(file, { flags: "a", mode: 0o600 });
    }
  }

  write(line: string): void {
    if (this.stream) {
      this.rotateIfNeeded();
      this.stream.write(line);
    }
    if (this.echo) process.stderr.write(line);
  }

  rotateIfNeeded(): void {
    const file = this.file;
    if (!file || !existsSync(file)) return;

    let size = 0;
    try {
      size = statSync(file).size;
    } catch {
      return;
    }
    if (size < MAX_BYTES) return;

    this.stream?.end();
    this.stream = undefined;

    const oldest = `${file}.${MAX_FILES}`;
    if (existsSync(oldest)) unlinkSync(oldest);
    for (let i = MAX_FILES - 1; i >= 1; i -= 1) {
      const from = `${file}.${i}`;
      if (existsSync(from)) renameSync(from, `${file}.${i + 1}`);
    }
    renameSync(file, `${file}.1`);
    this.stream = createWriteStream(file, { flags: "a", mode: 0o600 });
  }

  async close(): Promise<void> {
    const stream = this.stream;
    this.stream = undefined;
    if (!stream) return;
    await new Promise<void>((resolve) => stream.end(resolve));
  }
}

/**
 * Structured local logger.
 *
 * The project's privacy rules are enforced at the call sites, not here: nothing in this
 * codebase passes transcripts, final text, the system prompt, the glossary, environment
 * values or CLI auth metadata to a log call. Text is described by length, never content.
 */
export class Logger {
  readonly #sink: LogSink;
  readonly #context: Record<string, unknown>;

  private constructor(sink: LogSink, context: Record<string, unknown>) {
    this.#sink = sink;
    this.#context = context;
  }

  static create(options: {
    level?: LogLevel;
    logsDir?: string;
    fileName?: string;
    context?: Record<string, unknown>;
    /** Mirror to stderr; on by default so `make dev` shows something useful. */
    echo?: boolean;
  } = {}): Logger {
    let file: string | undefined;
    if (options.logsDir) {
      mkdirSync(options.logsDir, { recursive: true, mode: 0o700 });
      file = join(options.logsDir, options.fileName ?? "core.log");
    }
    const sink = new LogSink(options.level ?? "info", options.echo ?? true, file);
    return new Logger(sink, options.context ?? {});
  }

  setLevel(level: LogLevel): void {
    this.#sink.level = level;
  }

  child(context: Record<string, unknown>): Logger {
    return new Logger(this.#sink, { ...this.#context, ...context });
  }

  error(message: string, fields?: Record<string, unknown>): void {
    this.#write("error", message, fields);
  }
  warn(message: string, fields?: Record<string, unknown>): void {
    this.#write("warn", message, fields);
  }
  info(message: string, fields?: Record<string, unknown>): void {
    this.#write("info", message, fields);
  }
  debug(message: string, fields?: Record<string, unknown>): void {
    this.#write("debug", message, fields);
  }

  #write(level: LogLevel, message: string, fields?: Record<string, unknown>): void {
    if (LEVEL_ORDER[level] > LEVEL_ORDER[this.#sink.level]) return;
    const entry = {
      ts: new Date().toISOString(),
      level,
      msg: message,
      ...this.#context,
      ...fields,
    };
    this.#sink.write(`${JSON.stringify(entry)}\n`);
  }

  async close(): Promise<void> {
    await this.#sink.close();
  }
}
