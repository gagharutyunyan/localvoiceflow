import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { buildClaudeArgs, parseClaudeOutput, sanitizeClaudeMetadata } from "../dist/providers/claude.js";
import { buildCodexArgs, parseCodexLoginStatus, parseCodexOutput } from "../dist/providers/codex.js";
import { API_KEY_ENV_VARS, detectApiKeyEnv, runCli, subscriptionOnlyEnv } from "../dist/providers/spawn.js";
import { classifyCliFailure, summarizeStderr } from "../dist/providers/errors.js";

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
});
