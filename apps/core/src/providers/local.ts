import {
  PipelineError,
  correctionPayloadJson,
  type CorrectionInput,
  type CorrectionResult,
  type ProviderConfig,
  type ProviderHealth,
  type TextCorrectionProvider,
} from "@lvf/shared";
import type { LlmWorkerClient } from "../llm/worker-client.js";

/**
 * Appended to the (CLI-oriented) system prompt for the local model. The base prompt
 * asks for structured output, which the CLIs enforce with a JSON schema; the local
 * model has no such harness, so the contract is restated as plain text — and a small
 * few-shot block pins down the filler-word rule, which a 4B model otherwise applies
 * inconsistently. Measured on Qwen3-4B: fixes filler removal with no latency cost,
 * since the whole system prompt lives in the worker's KV cache.
 */
export const LOCAL_PROMPT_ADDENDUM = `

# Формат ответа (локальная модель)

Верни ТОЛЬКО отредактированный текст диктовки. Без JSON, без кавычек, без пояснений,
без повторения этих правил.

Слова-паразиты удаляй всегда: «эм», «ну», «вот», «как бы», «значит», «типа»,
«это самое», «короче» в начале фразы. Ложные начала («сделай… то есть не так,
сделай…») сворачивай в окончательную формулировку.

Примеры:
Вход: {"dictation": "эм ну сделай пожалуйста рефакторинг этого метода"}
Ответ: Сделай, пожалуйста, рефакторинг этого метода.

Вход: {"dictation": "добавь кнопку то есть не кнопку а ссылку на страницу настроек"}
Ответ: Добавь ссылку на страницу настроек.`;

/** The system prompt actually sent to (and cached by) the local worker. */
export function buildLocalSystemPrompt(basePrompt: string): string {
  return basePrompt + LOCAL_PROMPT_ADDENDUM;
}

/**
 * On-device text correction over the persistent MLX worker.
 *
 * No subprocess per request, no network, no auth: latency is pure prompt prefill and
 * generation, and the system prompt is served from the worker's KV cache. The
 * `model` in ProviderConfig is the Hugging Face repo id of an MLX model; changing it
 * restarts the worker (handled by main.ts via `reconfigure`).
 */
export class LocalMlxProvider implements TextCorrectionProvider {
  readonly id = "local-mlx" as const;

  readonly #worker: LlmWorkerClient;

  constructor(options: { worker: LlmWorkerClient }) {
    this.#worker = options.worker;
  }

  async health(): Promise<ProviderHealth> {
    const worker = await this.#worker.health();
    const value: ProviderHealth = {
      id: this.id,
      available: worker.state !== "stopped",
      // No account is involved; "authenticated" here means "usable".
      authenticated: worker.ready,
      apiKeyEnvPresent: [],
      missingFlags: [],
      ...(worker.model ? { version: worker.model } : {}),
      authDetail: worker.ready
        ? `on-device (${worker.warmedPrompt ? "prompt cached" : "warming up"})`
        : `worker ${worker.state}`,
      ...(worker.error ? { error: worker.error } : {}),
    };
    return value;
  }

  async correct(
    input: CorrectionInput,
    config: ProviderConfig,
    signal?: AbortSignal,
  ): Promise<CorrectionResult> {
    if (signal?.aborted) {
      throw new PipelineError("cancelled", "correction cancelled");
    }
    const workerHealth = this.#worker.currentHealth;
    if (!this.#worker.isRunning) {
      throw new PipelineError(
        "llm_failed",
        "the local correction worker is not running — is local-mlx selected in settings?",
      );
    }
    if (!workerHealth.ready) {
      throw new PipelineError(
        "llm_failed",
        `the local model is not ready (${workerHealth.state}${
          workerHealth.error ? `: ${workerHealth.error}` : ""
        })`,
      );
    }

    // The bare JSON, not the CLI preamble: the addendum in the system prompt already
    // frames the message as data and demands plain text back — a structured-output
    // instruction here would contradict it and confuse a 4B model.
    const payload = correctionPayloadJson(input);
    const startedAt = process.hrtime.bigint();

    const result = await this.#worker.correct(
      {
        systemPrompt: buildLocalSystemPrompt(config.systemPrompt),
        payload,
      },
      config.timeoutMs,
      signal,
    );

    const latencyMs = Number(process.hrtime.bigint() - startedAt) / 1e6;

    if (signal?.aborted) {
      throw new PipelineError("cancelled", "correction cancelled");
    }

    const text = result.text.trim();
    if (text.length === 0) {
      throw new PipelineError("llm_invalid_output", "the local model produced no text");
    }

    // A reply that ran into the token cap is truncated mid-sentence. Handing that to the
    // caller as a success would paste half a thought into the user's document and only
    // whisper about it in a warning; failing instead lets the retry and the raw-transcript
    // fallback do their job, and nothing the user said is lost.
    if (result.finishReason === "length") {
      throw new PipelineError(
        "llm_invalid_output",
        "the local model hit its token cap and returned a truncated reply",
      );
    }
    const warnings: string[] = [];

    return {
      finalText: text,
      provider: this.id,
      model: result.model,
      effort: config.effort,
      latencyMs,
      metadata: {
        promptTokens: result.promptTokens,
        generationTokens: result.generationTokens,
        generationMs: result.generationMs,
        finishReason: result.finishReason,
      },
      warnings,
    };
  }
}
