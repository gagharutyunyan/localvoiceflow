import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { CorrectionInput, ProviderConfig } from "@lvf/shared";
import { Logger } from "../dist/logger.js";
import { LlmWorkerClient } from "../dist/llm/worker-client.js";
import {
  LOCAL_PROMPT_ADDENDUM,
  LocalMlxProvider,
  buildLocalSystemPrompt,
} from "../dist/providers/local.js";

const INPUT: CorrectionInput = {
  rawTranscript: "эм ну сделай рефакторинг",
  language: "ru",
  glossary: [],
  profile: "developer",
};

const CONFIG: ProviderConfig = {
  model: "fake/qwen",
  effort: "low",
  timeoutMs: 5000,
  systemPrompt: "Ты — редактор.",
  disableThinking: true,
};

// ---------------------------------------------------------------------------
// A scripted stand-in for `python -m lvf_stt --role llm`, run with node. It
// speaks the real JSON Lines protocol; "SLOW" in the payload means never answer.
// ---------------------------------------------------------------------------

const FAKE_WORKER_JS = `
const readline = require("node:readline");
const put = (obj) => process.stdout.write(JSON.stringify(obj) + "\\n");
put({ id: null, ok: true, op: "status", state: "starting", ready: false, model: "fake/qwen" });
put({ id: null, ok: true, op: "status", state: "ready", ready: true, model: "fake/qwen", load_ms: 42 });
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  let m;
  try { m = JSON.parse(line); } catch { return; }
  if (m.op === "warm") {
    put({ id: m.id, ok: true, op: "warm", warmed: true, prompt_tokens: 100, warm_ms: 5 });
    put({ id: null, ok: true, op: "status", state: "ready", ready: true, model: "fake/qwen", load_ms: 42, warmed_prompt: true });
  } else if (m.op === "correct") {
    if (String(m.payload).includes("SLOW")) return;
    put({ id: m.id, ok: true, op: "correct", text: "Сделай рефакторинг.", model: "fake/qwen",
          prompt_tokens: 10, generation_tokens: 5, generation_ms: 100, finish_reason: "stop",
          echo_system_prompt: undefined });
  } else if (m.op === "health") {
    put({ id: m.id, ok: true, op: "health", state: "ready", ready: true, backend: "mlx-lm",
          model: "fake/qwen", load_ms: 42, warmed_prompt: true });
  } else if (m.op === "cancel") {
    put({ id: m.id, ok: true, op: "cancel", target_id: m.target_id, cancelled: true });
  } else if (m.op === "shutdown") {
    put({ id: m.id, ok: true, op: "shutdown" });
    process.exit(0);
  }
});
rl.on("close", () => process.exit(0));
`;

const scratch = mkdtempSync(join(tmpdir(), "lvf-llm-test-"));
const fakeWorkerPath = join(scratch, "fake-llm-worker.cjs");
writeFileSync(fakeWorkerPath, FAKE_WORKER_JS);
after(() => rmSync(scratch, { recursive: true, force: true }));

function makeClient(): LlmWorkerClient {
  const spawnCalls: string[][] = [];
  const client = new LlmWorkerClient({
    // existsSync must pass; the spawnFn below ignores it and runs the fake.
    pythonPath: process.execPath,
    workerDir: scratch,
    model: "fake/qwen",
    logger: Logger.create({ level: "error", echo: false }),
    spawnFn: ((_cmd: string, args: string[], opts: object) => {
      spawnCalls.push(args);
      return spawn(process.execPath, [fakeWorkerPath], opts as never);
    }) as never,
  });
  (client as unknown as { spawnCalls: string[][] }).spawnCalls = spawnCalls;
  return client;
}

function waitForReady(client: LlmWorkerClient): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("worker never became ready")), 5000);
    const check = (health: { ready: boolean }) => {
      if (health.ready) {
        clearTimeout(timer);
        client.off("health", check);
        resolve();
      }
    };
    client.on("health", check);
    if (client.currentHealth.ready) check({ ready: true });
  });
}

/** Runs the body and always stops the client — a leaked child keeps the event loop alive. */
async function withClient(body: (client: LlmWorkerClient) => Promise<void>): Promise<void> {
  const client = makeClient();
  try {
    await body(client);
  } finally {
    await client.stop();
  }
}

function pollUntil(check: () => boolean, what: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const timer = setInterval(() => {
      if (check()) {
        clearInterval(timer);
        resolve();
      } else if (Date.now() - startedAt > 5000) {
        clearInterval(timer);
        reject(new Error(`timed out waiting for ${what}`));
      }
    }, 10);
  });
}

describe("LlmWorkerClient against a scripted worker", () => {
  test("start → ready → correct → stop round trip", async () => {
    const client = makeClient();
    client.start();
    await waitForReady(client);

    assert.equal(client.currentHealth.state, "ready");
    assert.equal(client.currentHealth.backend, "mlx-lm");

    const result = await client.correct(
      { systemPrompt: "s", payload: '{"dictation":"эм ну"}' },
      2000,
    );
    assert.equal(result.text, "Сделай рефакторинг.");
    assert.equal(result.model, "fake/qwen");
    assert.equal(result.finishReason, "stop");
    assert.equal(result.generationTokens, 5);

    await client.stop();
    assert.equal(client.isRunning, false);
    assert.equal(client.currentHealth.state, "stopped");
  });

  test("warm resolves and flips warmedPrompt via the status event", async () => {
    await withClient(async (client) => {
      client.start();
      await waitForReady(client);
      await client.warm("Ты — редактор.");
      // The unsolicited status event lands asynchronously right after the reply.
      await pollUntil(() => client.currentHealth.warmedPrompt === true, "warmedPrompt");
    });
  });

  test("a request that never answers times out as llm_timeout", async () => {
    await withClient(async (client) => {
      client.start();
      await waitForReady(client);
      await assert.rejects(
        client.correct({ systemPrompt: "s", payload: "SLOW" }, 300),
        (error: Error & { code?: string }) => error.code === "llm_timeout",
      );
    });
  });

  test("an aborted request rejects as cancelled", async () => {
    await withClient(async (client) => {
      client.start();
      await waitForReady(client);
      const controller = new AbortController();
      const pending = assert.rejects(
        client.correct({ systemPrompt: "s", payload: "SLOW" }, 5000, controller.signal),
        (error: Error & { code?: string }) => error.code === "cancelled",
      );
      setTimeout(() => controller.abort(), 50);
      await pending;
    });
  });

  test("correct without a running worker fails fast", async () => {
    const client = makeClient();
    await assert.rejects(
      client.correct({ systemPrompt: "s", payload: "p" }, 1000),
      (error: Error & { code?: string }) => error.code === "llm_failed",
    );
  });

  test("reconfigure with a new model restarts the running worker", async () => {
    await withClient(async (client) => {
      const calls = (client as unknown as { spawnCalls: string[][] }).spawnCalls;
      client.start();
      await waitForReady(client);
      assert.equal(calls.length, 1);
      assert.deepEqual(calls[0].slice(-2), ["--model", "fake/qwen"]);

      const restarted = client.reconfigure({ model: "fake/other" });
      assert.equal(restarted, true);
      // The restart is asynchronous (stop → start); wait for the second spawn.
      await pollUntil(() => calls.length === 2, "the restart spawn");
      assert.deepEqual(calls[1].slice(-2), ["--model", "fake/other"]);
      await pollUntil(() => client.currentHealth.ready, "ready after restart");
    });
  });

  test("reconfigure with the same model does not restart", async () => {
    await withClient(async (client) => {
      const calls = (client as unknown as { spawnCalls: string[][] }).spawnCalls;
      client.start();
      await waitForReady(client);
      assert.equal(client.reconfigure({ model: "fake/qwen" }), false);
      assert.equal(calls.length, 1);
    });
  });
});

// ---------------------------------------------------------------------------
// LocalMlxProvider over a duck-typed client — no process at all.
// ---------------------------------------------------------------------------

interface FakeWorkerState {
  running: boolean;
  ready: boolean;
  state: string;
  error?: string;
  text?: string;
  finishReason?: string;
  lastRequest?: { systemPrompt: string; payload: string };
}

function fakeWorker(state: FakeWorkerState): LlmWorkerClient {
  return {
    get isRunning() {
      return state.running;
    },
    get currentHealth() {
      return {
        ready: state.ready,
        state: state.state,
        backend: "mlx-lm",
        model: "fake/qwen",
        warmedPrompt: true,
        ...(state.error ? { error: state.error } : {}),
      };
    },
    async health() {
      return this.currentHealth;
    },
    async correct(input: { systemPrompt: string; payload: string }) {
      state.lastRequest = input;
      return {
        text: state.text ?? "Готово.",
        model: "fake/qwen",
        promptTokens: 1300,
        generationTokens: 8,
        generationMs: 250,
        finishReason: state.finishReason ?? "stop",
      };
    },
  } as unknown as LlmWorkerClient;
}

describe("LocalMlxProvider", () => {
  test("happy path maps the worker reply into a CorrectionResult", async () => {
    const state: FakeWorkerState = { running: true, ready: true, state: "ready" };
    const provider = new LocalMlxProvider({ worker: fakeWorker(state) });

    const result = await provider.correct(INPUT, CONFIG);
    assert.equal(result.finalText, "Готово.");
    assert.equal(result.provider, "local-mlx");
    assert.equal(result.model, "fake/qwen");
    assert.ok(result.latencyMs >= 0);
    assert.equal(result.metadata?.finishReason, "stop");
    assert.deepEqual(result.warnings, []);

    // The worker gets the local addendum appended to the configured prompt, and
    // the payload is the JSON serialization, not the raw transcript.
    assert.ok(state.lastRequest!.systemPrompt.startsWith(CONFIG.systemPrompt));
    assert.ok(state.lastRequest!.systemPrompt.endsWith(LOCAL_PROMPT_ADDENDUM));
    assert.ok(state.lastRequest!.payload.includes("эм ну сделай рефакторинг"));
    assert.ok(state.lastRequest!.payload.trimStart().startsWith("{"));
  });

  test("a stopped worker is llm_failed with a pointed message", async () => {
    const provider = new LocalMlxProvider({
      worker: fakeWorker({ running: false, ready: false, state: "stopped" }),
    });
    await assert.rejects(
      provider.correct(INPUT, CONFIG),
      (error: Error & { code?: string }) =>
        error.code === "llm_failed" && error.message.includes("not running"),
    );
  });

  test("a loading worker is llm_failed naming the state", async () => {
    const provider = new LocalMlxProvider({
      worker: fakeWorker({ running: true, ready: false, state: "loading" }),
    });
    await assert.rejects(
      provider.correct(INPUT, CONFIG),
      (error: Error & { code?: string }) =>
        error.code === "llm_failed" && error.message.includes("loading"),
    );
  });

  test("an empty reply is llm_invalid_output", async () => {
    const provider = new LocalMlxProvider({
      worker: fakeWorker({ running: true, ready: true, state: "ready", text: "   " }),
    });
    await assert.rejects(
      provider.correct(INPUT, CONFIG),
      (error: Error & { code?: string }) => error.code === "llm_invalid_output",
    );
  });

  test("a length-capped reply carries a warning", async () => {
    const provider = new LocalMlxProvider({
      worker: fakeWorker({
        running: true,
        ready: true,
        state: "ready",
        finishReason: "length",
      }),
    });
    const result = await provider.correct(INPUT, CONFIG);
    assert.equal(result.warnings.length, 1);
    assert.ok(result.warnings[0].includes("token cap"));
  });

  test("an already-aborted signal never reaches the worker", async () => {
    const state: FakeWorkerState = { running: true, ready: true, state: "ready" };
    const provider = new LocalMlxProvider({ worker: fakeWorker(state) });
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      provider.correct(INPUT, CONFIG, controller.signal),
      (error: Error & { code?: string }) => error.code === "cancelled",
    );
    assert.equal(state.lastRequest, undefined);
  });

  test("health maps worker readiness into provider health", async () => {
    const ready = new LocalMlxProvider({
      worker: fakeWorker({ running: true, ready: true, state: "ready" }),
    });
    const health = await ready.health();
    assert.equal(health.id, "local-mlx");
    assert.equal(health.available, true);
    assert.equal(health.authenticated, true);
    assert.ok(health.authDetail!.includes("on-device"));

    const stopped = new LocalMlxProvider({
      worker: fakeWorker({ running: false, ready: false, state: "stopped" }),
    });
    const stoppedHealth = await stopped.health();
    assert.equal(stoppedHealth.available, false);
    assert.equal(stoppedHealth.authenticated, false);
  });

  test("the local prompt addendum pins the output contract", () => {
    const prompt = buildLocalSystemPrompt("База.");
    assert.ok(prompt.startsWith("База."));
    assert.ok(prompt.includes("ТОЛЬКО отредактированный текст"));
    assert.ok(prompt.includes("Слова-паразиты"));
  });
});
