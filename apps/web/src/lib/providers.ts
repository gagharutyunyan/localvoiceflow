import { CLAUDE_EFFORTS, CODEX_EFFORTS } from "@lvf/shared";
import type { CommandPreview, ProviderCapability } from "../api/types";

export const PROVIDER_LABELS: Record<string, string> = {
  "claude-cli": "Claude Code subscription",
  "openai-codex-cli": "OpenAI Codex subscription",
  mock: "Mock provider (testing)",
};

export function providerLabel(id: string): string {
  return PROVIDER_LABELS[id] ?? id;
}

/**
 * Effort values come from the server when it exposes `/api/providers`; otherwise the
 * lists in `@lvf/shared` are used, which were derived from the installed CLIs
 * themselves (Codex has `none`, Claude does not; neither has `minimal`).
 */
export function effortsFor(
  provider: string,
  capabilities: ProviderCapability[] | null | undefined,
): string[] {
  const reported = capabilities?.find((entry) => entry.id === provider);
  if (reported && reported.efforts.length > 0) return [...reported.efforts];
  if (provider === "claude-cli") return [...CLAUDE_EFFORTS];
  if (provider === "openai-codex-cli") return [...CODEX_EFFORTS];
  return ["low"];
}

export function modelsFor(
  provider: string,
  capabilities: ProviderCapability[] | null | undefined,
): string[] {
  const reported = capabilities?.find((entry) => entry.id === provider);
  return reported?.models ? [...reported.models] : [];
}

export interface CommandPreviewInput {
  provider: string;
  model: string;
  effort: string;
  disableThinking: boolean;
  timeoutMs: number;
}

const STDIN_NOTE =
  "stdin: JSON payload (application context + glossary + dictated text). The text is never placed in argv.";

/**
 * Reconstructs the argv core spawns, from the flag set verified in
 * docs/IMPLEMENTATION_PLAN.md. It contains no user text and no secrets: file paths
 * are shown as placeholders and the payload goes to stdin. When core reports its own
 * `commandPreview`, that one is displayed instead of this reconstruction.
 */
export function buildCommandPreview(input: CommandPreviewInput): CommandPreview {
  if (input.provider === "openai-codex-cli") {
    return {
      provider: input.provider,
      label: "codex exec (subscription auth, sandboxed, no user config)",
      argv: [
        "codex",
        "exec",
        "-m",
        input.model,
        "-c",
        `model_reasoning_effort="${input.effort}"`,
        "-c",
        "tools.web_search=false",
        "--sandbox",
        "read-only",
        "--skip-git-repo-check",
        "--ephemeral",
        "--ignore-user-config",
        "--ignore-rules",
        "-C",
        "<empty temporary directory>",
        "--output-schema",
        "<correction-schema.json>",
        "-o",
        "<temporary output file>",
        "-",
      ],
      env: [{ name: "PATH", value: "<inherited>" }],
      stdin: STDIN_NOTE,
    };
  }

  const env: CommandPreview["env"] = [{ name: "PATH", value: "<inherited>" }];
  if (input.disableThinking) env.push({ name: "MAX_THINKING_TOKENS", value: "0" });

  return {
    provider: input.provider,
    label: "claude -p (subscription auth, --safe-mode, no session persistence)",
    argv: [
      "claude",
      "-p",
      "--model",
      input.model,
      "--effort",
      input.effort,
      "--output-format",
      "json",
      "--json-schema",
      "<correction-schema.json>",
      "--system-prompt-file",
      "<system prompt file>",
      "--max-turns",
      "1",
      "--no-session-persistence",
      "--safe-mode",
      "--strict-mcp-config",
    ],
    env,
    stdin: STDIN_NOTE,
  };
}
