import { PipelineError } from "@lvf/shared";

/**
 * Classifies a CLI failure into an actionable error code.
 *
 * The retry policy hangs off this: only a transient network problem is worth one retry.
 * A missing login or an unavailable model will fail identically on the second attempt and
 * would just burn another few seconds of the user's wait.
 */
export function classifyCliFailure(
  stderr: string,
  stdout: string,
  exitCode: number | null,
  timedOut: boolean,
): PipelineError {
  if (timedOut) {
    return new PipelineError("llm_timeout", "the CLI did not respond before the timeout");
  }

  const haystack = `${stderr}\n${stdout}`.toLowerCase();

  const matches = (...needles: string[]): boolean =>
    needles.some((needle) => haystack.includes(needle));

  if (matches("not logged in", "please run /login", "please login", "unauthorized", "401", "authentication_error", "invalid api key", "no credentials")) {
    return new PipelineError(
      "llm_not_authenticated",
      "the CLI is not authenticated — sign in again with your subscription",
    );
  }

  if (matches("rate limit", "429", "too many requests", "usage limit", "quota")) {
    return new PipelineError("llm_rate_limited", "the provider rate-limited or exhausted the quota");
  }

  if (matches("unsupported_value", "model not found", "unknown model", "does not exist", "invalid model", "not supported with the")) {
    return new PipelineError(
      "llm_model_unavailable",
      "the selected model or effort is not available to this subscription",
    );
  }

  if (matches("enotfound", "econnrefused", "econnreset", "etimedout", "network", "getaddrinfo", "socket hang up", "fetch failed")) {
    return new PipelineError("llm_network", "network error talking to the provider", {
      retryable: true,
    });
  }

  const detail = exitCode === null ? "terminated by signal" : `exit code ${exitCode}`;
  return new PipelineError("llm_failed", `the CLI failed (${detail})`);
}

/** Short, non-sensitive summary of CLI stderr, safe to store in a history record. */
export function summarizeStderr(stderr: string, limit = 400): string {
  const cleaned = stderr
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    // Anything that looks like a credential is dropped rather than truncated.
    .filter((line) => !/token|bearer|api[_-]?key|authorization|secret/i.test(line))
    .join(" | ");
  return cleaned.length > limit ? `${cleaned.slice(0, limit)}…` : cleaned;
}
