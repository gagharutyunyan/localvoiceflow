import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { CorrectionInput, ProviderConfig } from "@lvf/shared";
import { ClaudeCliProvider, buildClaudeArgs, parseClaudeOutput, sanitizeClaudeMetadata } from "../dist/providers/claude.js";
import { CodexCliProvider, buildCodexArgs, parseCodexLoginStatus, parseCodexOutput } from "../dist/providers/codex.js";
import { API_KEY_ENV_VARS, detectApiKeyEnv, runCli, startCli, subscriptionOnlyEnv } from "../dist/providers/spawn.js";
import { classifyCliFailure, summarizeStderr } from "../dist/providers/errors.js";
import { clearExecutableCache } from "../dist/providers/which.js";
import { containsTerm, leaksTerm } from "../dist/fixture-match.js";

describe("claude command builder", () => {
  test("emits the subscription-safe flag set", () => {
    const args = buildClaudeArgs({
      model: "haiku",
      effort: "low",
      systemPromptFile: "/tmp/sp.md",
    });

    assert.equal(args[0], "-p");
    assert.ok(args.includes("--safe-mode"), "must isolate from user config");
    assert.ok(args.includes("--no-session-persistence"));
    assert.ok(args.includes("--strict-mcp-config"));
    assert.deepEqual(
      args.slice(args.indexOf("--disallowed-tools"), args.indexOf("--disallowed-tools") + 2),
      ["--disallowed-tools", "mcp__*"],
    );
    assert.deepEqual(args.slice(args.indexOf("--model"), args.indexOf("--model") + 2), [
      "--model",
      "haiku",
    ]);
    assert.deepEqual(args.slice(args.indexOf("--effort"), args.indexOf("--effort") + 2), [
      "--effort",
      "low",
    ]);
  });

  test("never uses --bare, which would force API-key auth", () => {
    const args = buildClaudeArgs({ model: "opus", effort: "high", systemPromptFile: "/tmp/x" });
    assert.ok(!args.includes("--bare"));
  });

  test("the dictated text is not in argv at all", () => {
    const args = buildClaudeArgs({ model: "haiku", effort: "low", systemPromptFile: "/tmp/x" });
    // Nothing in argv should be free-form user content; the payload goes over stdin.
    for (const arg of args) {
      assert.ok(!arg.includes("юз эффект"), `argv leaked user text: ${arg}`);
    }
  });

  test("--tools is never the final element, because it is variadic", () => {
    const args = buildClaudeArgs({ model: "haiku", effort: "low", systemPromptFile: "/tmp/x" });
    const toolsIndex = args.indexOf("--tools");
    assert.ok(toolsIndex >= 0);
    // "" is its value; anything after it would be swallowed by the variadic.
    assert.equal(args[toolsIndex + 1], "");
    assert.equal(args.length, toolsIndex + 2, "nothing may follow --tools \"\"");
  });

  test("degrades when the installed CLI lacks a flag", () => {
    const args = buildClaudeArgs({
      model: "haiku",
      effort: "low",
      systemPromptFile: "/tmp/x",
      supportedFlags: new Set(["--model", "--output-format"]),
    });
    assert.ok(!args.includes("--safe-mode"));
    assert.ok(!args.includes("--json-schema"));
    assert.ok(args.includes("--model"));
    assert.ok(args.includes("--output-format"));
  });
});

describe("codex command builder", () => {
  const args = buildCodexArgs({
    model: "gpt-5.6-luna",
    effort: "none",
    workDir: "/tmp/empty",
    schemaFile: "/tmp/schema.json",
    outputFile: "/tmp/out.json",
  });

  test("runs read-only, ephemeral and without web search", () => {
    assert.equal(args[0], "exec");
    assert.deepEqual(args.slice(args.indexOf("--sandbox"), args.indexOf("--sandbox") + 2), [
      "--sandbox",
      "read-only",
    ]);
    assert.ok(args.includes("--ephemeral"));
    assert.ok(args.includes("--ignore-user-config"));
    assert.ok(args.includes("--skip-git-repo-check"));
    assert.ok(args.includes("tools.web_search=false"));
  });

  test("passes reasoning effort through -c, and ends with the stdin marker", () => {
    assert.ok(args.includes('model_reasoning_effort="none"'));
    assert.equal(args.at(-1), "-", "the prompt must come from stdin");
  });

  test("does not pass --ask-for-approval, which codex 0.147 exec does not accept", () => {
    assert.ok(!args.includes("--ask-for-approval"));
  });
});

describe("fixture term matching", () => {
  test("an identifier must keep its exact casing", () => {
    assert.equal(containsTerm("этот useEffect снова вызывает fetch", "useEffect"), true);
    assert.equal(containsTerm("этот useeffect снова вызывает fetch", "useEffect"), false);
    assert.equal(containsTerm("добавь AbortController", "AbortController"), true);
    assert.equal(containsTerm("добавь abortcontroller", "AbortController"), false);
  });

  test("an ordinary word survives sentence capitalisation", () => {
    // The model may drop a leading "Этот", which capitalises the next word. The term still
    // survived, so reporting it missing would flag correct output as a regression.
    assert.equal(containsTerm("Компонент слишком большой", "компонент"), true);
    assert.equal(containsTerm("Этот компонент слишком большой", "компонент"), true);
    assert.equal(containsTerm("тут ничего похожего нет", "компонент"), false);
  });

  test("a leak is caught in any casing", () => {
    assert.equal(leaksTerm("этот Юз Эффект остался", "юз эффект"), true);
    assert.equal(leaksTerm("этот useEffect исправлен", "юз эффект"), false);
  });
});

describe("codex login status", () => {
  test("recognises a login reported on stderr", () => {
    // Regression: the real CLI prints this on stderr. Reading stdout alone reported an
    // authenticated CLI as signed out and disabled the provider entirely.
    const status = parseCodexLoginStatus({
      code: 0,
      stdout: "",
      stderr: "Logged in using ChatGPT\n",
    });
    assert.equal(status.authenticated, true);
    assert.equal(status.detail, "ChatGPT subscription");
  });

  test("recognises a login reported on stdout", () => {
    const status = parseCodexLoginStatus({
      code: 0,
      stdout: "Logged in using ChatGPT\n",
      stderr: "",
    });
    assert.equal(status.authenticated, true);
  });

  test("a signed-out CLI is reported as not logged in", () => {
    const status = parseCodexLoginStatus({
      code: 1,
      stdout: "",
      stderr: "Not logged in. Run `codex login`.\n",
    });
    assert.equal(status.authenticated, false);
    assert.equal(status.detail, "not logged in");
  });

  test("a non-zero exit is never treated as authenticated", () => {
    // Guards against the message appearing in an error path.
    const status = parseCodexLoginStatus({
      code: 2,
      stdout: "Logged in using ChatGPT",
      stderr: "",
    });
    assert.equal(status.authenticated, false);
  });
});

describe("environment scrubbing", () => {
  test("removes every API-key variable from the child environment", () => {
    const base = {
      PATH: "/usr/bin",
      HOME: "/Users/x",
      ANTHROPIC_API_KEY: "sk-ant-should-not-survive",
      OPENAI_API_KEY: "sk-openai-should-not-survive",
      CODEX_API_KEY: "codex-should-not-survive",
      ANTHROPIC_AUTH_TOKEN: "tok",
    } satisfies NodeJS.ProcessEnv;

    const scrubbed = subscriptionOnlyEnv(base);

    for (const name of API_KEY_ENV_VARS) {
      assert.equal(scrubbed[name], undefined, `${name} must not reach the child`);
    }
    assert.equal(scrubbed.PATH, "/usr/bin", "unrelated variables are preserved");
    assert.equal(scrubbed.HOME, "/Users/x");
  });

  test("extra variables are applied after scrubbing", () => {
    const scrubbed = subscriptionOnlyEnv({ ANTHROPIC_API_KEY: "x" }, { MAX_THINKING_TOKENS: "0" });
    assert.equal(scrubbed.MAX_THINKING_TOKENS, "0");
    assert.equal(scrubbed.ANTHROPIC_API_KEY, undefined);
  });

  test("detectApiKeyEnv reports names only", () => {
    const names = detectApiKeyEnv({ OPENAI_API_KEY: "secret-value", PATH: "/bin" });
    assert.deepEqual(names, ["OPENAI_API_KEY"]);
    assert.ok(!names.join(" ").includes("secret-value"));
  });

  test("an empty string does not count as present", () => {
    assert.deepEqual(detectApiKeyEnv({ ANTHROPIC_API_KEY: "" }), []);
  });
});

describe("claude output parser", () => {
  test("prefers structured_output", () => {
    const stdout = JSON.stringify({
      is_error: false,
      structured_output: { text: "Готовый текст." },
      result: '{"text":"Готовый текст."}',
      duration_ms: 1614,
      usage: { output_tokens: 93 },
    });
    assert.equal(parseClaudeOutput(stdout).text, "Готовый текст.");
  });

  test("falls back to a JSON string in result", () => {
    const stdout = JSON.stringify({ is_error: false, result: '{"text":"Из result."}' });
    assert.equal(parseClaudeOutput(stdout).text, "Из result.");
  });

  test("falls back to plain text in result", () => {
    const stdout = JSON.stringify({ is_error: false, result: "Просто текст." });
    assert.equal(parseClaudeOutput(stdout).text, "Просто текст.");
  });

  test("rejects an error envelope", () => {
    const stdout = JSON.stringify({ is_error: true, subtype: "error_max_turns", result: "boom" });
    assert.throws(() => parseClaudeOutput(stdout), /reported an error/);
  });

  test("rejects invalid JSON", () => {
    assert.throws(() => parseClaudeOutput("not json at all"), /not valid JSON/);
  });

  test("rejects empty output", () => {
    assert.throws(() => parseClaudeOutput("   "), /no output/);
  });

  test("metadata keeps timings and drops everything identifying", () => {
    const meta = sanitizeClaudeMetadata({
      duration_ms: 1614,
      duration_api_ms: 3043,
      num_turns: 2,
      subtype: "success",
      total_cost_usd: 0.0048,
      usage: { anything: 1 },
    });
    assert.deepEqual(meta, {
      durationMs: 1614,
      apiDurationMs: 3043,
      numTurns: 2,
      subtype: "success",
      costUsd: 0.0048,
    });
    assert.ok(!("session_id" in meta));
  });
});

describe("codex output parser", () => {
  test("reads the -o output file", () => {
    assert.equal(parseCodexOutput('{"text":"Из файла."}', "irrelevant stdout"), "Из файла.");
  });

  test("falls back to the last JSON object on stdout", () => {
    const stdout = [
      "OpenAI Codex v0.147.0",
      "--------",
      'workdir: {"not":"the answer"}',
      "codex",
      '{"text":"Из stdout."}',
      "tokens used",
    ].join("\n");
    assert.equal(parseCodexOutput(undefined, stdout), "Из stdout.");
  });

  test("rejects output with no valid structured object", () => {
    assert.throws(() => parseCodexOutput(undefined, "no json here"), /no valid structured output/);
  });

  test("rejects a JSON object of the wrong shape", () => {
    assert.throws(
      () => parseCodexOutput('{"answer":"wrong key"}', ""),
      /no valid structured output/,
    );
  });
});

describe("failure classification", () => {
  test("auth failures are not retryable", () => {
    const error = classifyCliFailure("Error: not logged in", "", 1, false);
    assert.equal(error.code, "llm_not_authenticated");
    assert.equal(error.retryable, false);
  });

  test("an unavailable model is not retryable", () => {
    const error = classifyCliFailure(
      "Unsupported value: 'minimal' is not supported with the 'gpt-5.6-luna' model",
      "",
      1,
      false,
    );
    assert.equal(error.code, "llm_model_unavailable");
    assert.equal(error.retryable, false);
  });

  test("rate limits are recognised", () => {
    assert.equal(classifyCliFailure("429 Too Many Requests", "", 1, false).code, "llm_rate_limited");
  });

  test("an is_error envelope keeps the CLI's own diagnosis instead of a generic failure", () => {
    // Opus rejects the top efforts while thinking is off; the CLI reports it inside a
    // successful-looking JSON envelope, so the code has to come from `result`.
    const envelope = JSON.stringify({
      is_error: true,
      result:
        "API Error: 400 output_config.effort 'max' is not supported when thinking is disabled on this model. Use effort 'high' or below, or enable thinking.",
    });
    assert.throws(
      () => parseClaudeOutput(envelope),
      (error: Error & { code?: string; retryable?: boolean }) =>
        error.code === "llm_model_unavailable" && error.retryable === false,
    );
  });

  test("network errors are the only retryable class", () => {
    const error = classifyCliFailure("getaddrinfo ENOTFOUND api.example", "", 1, false);
    assert.equal(error.code, "llm_network");
    assert.equal(error.retryable, true);
  });

  test("a timeout beats every other signal", () => {
    assert.equal(classifyCliFailure("not logged in", "", null, true).code, "llm_timeout");
  });

  test("stderr summaries drop credential-looking lines", () => {
    const summary = summarizeStderr(
      ["warning: slow response", "Authorization: Bearer sk-ant-123", "hint: retry"].join("\n"),
    );
    assert.ok(!summary.includes("sk-ant-123"));
    assert.ok(summary.includes("slow response"));
  });
});

describe("runCli", () => {
  test("passes arguments literally, with no shell expansion", async () => {
    // If a shell were involved, $HOME and the glob would be expanded.
    const result = await runCli("/bin/echo", {
      args: ["$HOME", "*", "a b", "'quoted'", "</dictation>"],
      cwd: process.cwd(),
      env: {},
      timeoutMs: 5000,
    });
    assert.equal(result.code, 0);
    assert.equal(result.stdout.trim(), "$HOME * a b 'quoted' </dictation>");
  });

  test("writes the payload to stdin rather than argv", async () => {
    const result = await runCli("/bin/cat", {
      args: [],
      cwd: process.cwd(),
      env: {},
      stdin: 'полезная нагрузка с "кавычками" и </dictation>',
      timeoutMs: 5000,
    });
    assert.equal(result.stdout, 'полезная нагрузка с "кавычками" и </dictation>');
  });

  test("does not leak scrubbed variables to the child", async () => {
    const result = await runCli("/usr/bin/env", {
      args: [],
      cwd: process.cwd(),
      env: subscriptionOnlyEnv({ ANTHROPIC_API_KEY: "leak-me", KEEP_ME: "yes" }),
      timeoutMs: 5000,
    });
    assert.ok(!result.stdout.includes("leak-me"));
    assert.ok(result.stdout.includes("KEEP_ME=yes"));
  });

  test("times out and reports it", async () => {
    const result = await runCli("/bin/sleep", {
      args: ["10"],
      cwd: process.cwd(),
      env: {},
      timeoutMs: 250,
    });
    assert.equal(result.timedOut, true);
    assert.notEqual(result.code, 0);
  });

  test("an abort signal terminates the child", async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);
    const result = await runCli("/bin/sleep", {
      args: ["10"],
      cwd: process.cwd(),
      env: {},
      timeoutMs: 10_000,
      signal: controller.signal,
    });
    assert.notEqual(result.code, 0, "the child must not have exited normally");
    assert.ok(result.durationMs < 5000, "cancellation must be prompt");
  });

  test("a signal aborted before the call prevents the spawn entirely", async () => {
    // Regression: an abort listener added to an already-fired signal never runs, so a
    // cancellation landing before runCli left the child unsupervised — it ran to
    // completion as if no signal had been passed at all.
    const dir = mkdtempSync(join(tmpdir(), "lvf-preaborted-"));
    const marker = join(dir, "ran");
    const controller = new AbortController();
    controller.abort();
    try {
      await assert.rejects(
        runCli("/usr/bin/touch", {
          args: [marker],
          cwd: process.cwd(),
          env: {},
          timeoutMs: 5000,
          signal: controller.signal,
        }),
        (error: Error & { code?: string }) => error.code === "cancelled",
      );
      // Give a would-be child time to run; the marker must never appear.
      await new Promise((resolve) => setTimeout(resolve, 150));
      assert.ok(!existsSync(marker), "the child must never have been spawned");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a missing executable is reported as llm_cli_missing", async () => {
    await assert.rejects(
      runCli("/nonexistent/definitely-not-here", {
        args: [],
        cwd: process.cwd(),
        env: {},
        timeoutMs: 2000,
      }),
      (error: Error & { code?: string }) => error.code === "llm_cli_missing",
    );
  });

  test(
    "settles even when a grandchild escapes the process group and keeps the pipes open",
    { skip: !existsSync("/usr/bin/perl") },
    async () => {
      // The grandchild calls setsid(), so the group-wide SIGTERM/SIGKILL cannot reach
      // it, and it inherits our stdout pipe — `close` would wait its full 8 seconds.
      const script =
        "use POSIX; my $pid = fork(); if ($pid == 0) { POSIX::setsid(); sleep 8; exit 0 } sleep 8";
      const startedAt = Date.now();
      await assert.rejects(
        runCli("/usr/bin/perl", {
          args: ["-e", script],
          cwd: process.cwd(),
          env: {},
          timeoutMs: 300,
        }),
        (error: Error & { code?: string }) => error.code === "llm_timeout",
      );
      const elapsed = Date.now() - startedAt;
      assert.ok(elapsed < 7000, `must settle before the grandchild exits (took ${elapsed} ms)`);
    },
  );
});

describe("startCli", () => {
  test("the child waits for feed(): stdin arrives late, output still complete", async () => {
    const handle = startCli("/bin/cat", { args: [], cwd: process.cwd(), env: {} });
    assert.equal(handle.alive, true);
    // The child sits blocked on stdin during this window — exactly the prewarm shape.
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(handle.alive, true, "an unfed cat must still be running");
    const result = await handle.feed({ stdin: "поздний ввод", timeoutMs: 5000 });
    assert.equal(result.code, 0);
    assert.equal(result.stdout, "поздний ввод");
  });

  test("dispose() kills an unconsumed child promptly", async () => {
    const handle = startCli("/bin/sleep", { args: ["10"], cwd: process.cwd(), env: {} });
    const startedAt = Date.now();
    handle.dispose();
    // feed() on a disposed child just returns the settled result.
    const result = await handle.feed({ timeoutMs: 5000 });
    assert.notEqual(result.code, 0, "the child must not have exited normally");
    assert.ok(Date.now() - startedAt < 3000, "disposal must be prompt");
    assert.equal(handle.alive, false);
  });

  test("a child that dies before feed() reports its exit, not a hang", async () => {
    const handle = startCli("/usr/bin/false", { args: [], cwd: process.cwd(), env: {} });
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(handle.alive, false);
    const result = await handle.feed({ stdin: "никому", timeoutMs: 5000 });
    assert.equal(result.code, 1);
  });

  test("an already-aborted signal at feed() kills the child and rejects", async () => {
    const handle = startCli("/bin/cat", { args: [], cwd: process.cwd(), env: {} });
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      handle.feed({ stdin: "не должно уйти", timeoutMs: 5000, signal: controller.signal }),
      (error: Error & { code?: string }) => error.code === "cancelled",
    );
  });
});

describe("correct() hot path spawns no health probes", () => {
  const config: ProviderConfig = {
    model: "test-model",
    effort: "low",
    timeoutMs: 10_000,
    systemPrompt: "правь текст",
    disableThinking: true,
  };
  const input: CorrectionInput = {
    rawTranscript: "сырой текст",
    language: "ru",
    glossary: [],
    profile: "smart",
  };

  /** Puts a fake CLI first on PATH, runs the body, then restores everything. */
  const withFakeCli = async (
    name: string,
    script: string,
    body: (dir: string, log: string) => Promise<void>,
  ): Promise<void> => {
    const dir = mkdtempSync(join(tmpdir(), `lvf-fake-${name}-`));
    const log = join(dir, "calls.log");
    writeFileSync(join(dir, name), script.replace(/__LOG__/g, log), { mode: 0o755 });
    const originalPath = process.env.PATH;
    process.env.PATH = `${dir}:${originalPath ?? ""}`;
    clearExecutableCache();
    try {
      await body(dir, log);
    } finally {
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
      clearExecutableCache();
      rmSync(dir, { recursive: true, force: true });
    }
  };

  test("claude: flag probes run once per process and auth is never pre-checked", async () => {
    // Regression: correct() used to call health() first — up to seven subprocesses
    // (version, auth status, five flag probes) adding seconds to a routine dictation.
    const script = [
      "#!/bin/sh",
      'printf \'%s\\n\' "$*" >> "__LOG__"',
      'case "$*" in',
      '  *--version*) echo "9.9.9 (fake)"; exit 0;;',
      "esac",
      "cat > /dev/null",
      `printf '%s' '{"is_error":false,"structured_output":{"text":"ГОТОВО"}}'`,
      "",
    ].join("\n");

    await withFakeCli("claude", script, async (dir, log) => {
      const provider = new ClaudeCliProvider({ workDir: dir });

      const first = await provider.correct(input, config);
      assert.equal(first.finalText, "ГОТОВО");

      const afterFirst = readFileSync(log, "utf8").trim().split("\n");
      const probeCount = afterFirst.filter((line) => line.includes("--version")).length;
      assert.equal(
        afterFirst.filter((line) => line.startsWith("-p")).length,
        1,
        "exactly one real CLI call",
      );
      assert.ok(
        afterFirst.every((line) => !line.includes("auth")),
        "correct() must never spawn an auth probe",
      );

      const second = await provider.correct(input, config);
      assert.equal(second.finalText, "ГОТОВО");

      const afterSecond = readFileSync(log, "utf8").trim().split("\n");
      assert.equal(
        afterSecond.filter((line) => line.includes("--version")).length,
        probeCount,
        "flag probes must not run again",
      );
      assert.equal(
        afterSecond.length,
        afterFirst.length + 1,
        "a warm correct() spawns exactly one process",
      );
    });
  });

  test("claude: an abort that precedes the spawn keeps the real CLI from starting", async () => {
    // Regression: the awaits ahead of the spawn (executable resolution, flag probes)
    // give Esc or shutdown a window to abort first; the real call then started anyway
    // with a dead signal, burning a full LLM invocation after the cancellation.
    const script = [
      "#!/bin/sh",
      'printf \'%s\\n\' "$*" >> "__LOG__"',
      'case "$*" in',
      '  *--version*) echo "9.9.9 (fake)"; exit 0;;',
      "esac",
      "cat > /dev/null",
      `printf '%s' '{"is_error":false,"structured_output":{"text":"НЕ ДОЛЖНО ВЕРНУТЬСЯ"}}'`,
      "",
    ].join("\n");

    await withFakeCli("claude", script, async (dir, log) => {
      const provider = new ClaudeCliProvider({ workDir: dir });
      const controller = new AbortController();
      controller.abort();

      await assert.rejects(
        provider.correct(input, config, controller.signal),
        (error: Error & { code?: string }) => error.code === "cancelled",
      );

      const lines = existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : [];
      assert.equal(
        lines.filter((line) => line.startsWith("-p")).length,
        0,
        "the real CLI call must never be spawned after the abort",
      );
    });
  });

  test("claude: a prewarmed child is consumed instead of a fresh spawn", async () => {
    const script = [
      "#!/bin/sh",
      'printf \'%s\\n\' "$*" >> "__LOG__"',
      'case "$*" in',
      '  *--version*) echo "9.9.9 (fake)"; exit 0;;',
      "esac",
      "cat > /dev/null",
      `printf '%s' '{"is_error":false,"structured_output":{"text":"ГОТОВО"}}'`,
      "",
    ].join("\n");

    const realCalls = (log: string): string[] =>
      (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : []).filter((line) =>
        line.startsWith("-p"),
      );
    const waitForSpawn = async (log: string): Promise<void> => {
      const deadline = Date.now() + 3000;
      while (Date.now() < deadline) {
        if (realCalls(log).length > 0) {
          // The slot is assigned in the same tick as the spawn; the child's shell wrote
          // the log line strictly later, so a short grace period is enough.
          await new Promise((resolve) => setTimeout(resolve, 50));
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      assert.fail("the prewarmed child never spawned");
    };

    await withFakeCli("claude", script, async (dir, log) => {
      const provider = new ClaudeCliProvider({ workDir: dir });

      provider.prewarm(config);
      await waitForSpawn(log);
      assert.equal(realCalls(log).length, 1, "prewarm spawns exactly one real call");

      const result = await provider.correct(input, config);
      assert.equal(result.finalText, "ГОТОВО");
      assert.equal(
        realCalls(log).length,
        1,
        "correct() must adopt the prewarmed child, not spawn a second one",
      );

      // A second dictation without a prewarm cold-spawns as before.
      const second = await provider.correct(input, config);
      assert.equal(second.finalText, "ГОТОВО");
      assert.equal(realCalls(log).length, 2);
    });
  });

  test("claude: cancelPrewarm() and a config mismatch both force a fresh spawn", async () => {
    const script = [
      "#!/bin/sh",
      'printf \'%s\\n\' "$*" >> "__LOG__"',
      'case "$*" in',
      '  *--version*) echo "9.9.9 (fake)"; exit 0;;',
      "esac",
      "cat > /dev/null",
      `printf '%s' '{"is_error":false,"structured_output":{"text":"ГОТОВО"}}'`,
      "",
    ].join("\n");

    const realCalls = (log: string): string[] =>
      (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : []).filter((line) =>
        line.startsWith("-p"),
      );
    const waitForSpawnCount = async (log: string, count: number): Promise<void> => {
      const deadline = Date.now() + 3000;
      while (Date.now() < deadline) {
        if (realCalls(log).length >= count) {
          await new Promise((resolve) => setTimeout(resolve, 50));
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      assert.fail(`the prewarmed child #${count} never spawned`);
    };

    await withFakeCli("claude", script, async (dir, log) => {
      const provider = new ClaudeCliProvider({ workDir: dir });

      // Cancelled prewarm: the child dies unconsumed, correct() spawns its own.
      provider.prewarm(config);
      await waitForSpawnCount(log, 1);
      provider.cancelPrewarm();
      const first = await provider.correct(input, config);
      assert.equal(first.finalText, "ГОТОВО");
      assert.equal(realCalls(log).length, 2, "a cancelled prewarm must not be consumed");

      // Mismatched prewarm: a stale child must never serve a different config.
      provider.prewarm(config);
      await waitForSpawnCount(log, 3);
      const second = await provider.correct(input, { ...config, model: "other-model" });
      assert.equal(second.finalText, "ГОТОВО");
      assert.equal(realCalls(log).length, 4, "a mismatched prewarm must not be consumed");
      assert.ok(
        realCalls(log)[3]!.includes("other-model"),
        "the fresh spawn must carry the requested model",
      );
    });
  });

  test("codex: correct() spawns exactly one process and no login probe", async () => {
    const script = [
      "#!/bin/sh",
      'printf \'%s\\n\' "$*" >> "__LOG__"',
      'out=""',
      'prev=""',
      'for a in "$@"; do',
      '  if [ "$prev" = "-o" ]; then out="$a"; fi',
      '  prev="$a"',
      "done",
      "cat > /dev/null",
      'if [ -n "$out" ]; then printf \'%s\' \'{"text":"ОТ КОДЕКСА"}\' > "$out"; fi',
      "exit 0",
      "",
    ].join("\n");

    await withFakeCli("codex", script, async (dir, log) => {
      const provider = new CodexCliProvider({ workDir: dir });

      const result = await provider.correct(input, config);
      assert.equal(result.finalText, "ОТ КОДЕКСА");

      const lines = readFileSync(log, "utf8").trim().split("\n");
      assert.equal(lines.length, 1, "no version/login/help probes in the hot path");
      assert.ok(lines[0]!.startsWith("exec"));
      assert.ok(!lines[0]!.includes("login"));
    });
  });
});
