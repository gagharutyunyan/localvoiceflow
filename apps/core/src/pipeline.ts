import { randomUUID } from "node:crypto";
import { copyFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  PipelineError,
  applyDeterministicReplacements,
  buildSttInitialPrompt,
  resolveProfile,
  selectGlossary,
  type CorrectionInput,
  type DictationContext,
  type DictationOutcome,
  type DictationRecord,
  type FormattingProfile,
  type ProviderId,
  type Settings,
  type SttProvider,
  type TextCorrectionProvider,
} from "@lvf/shared";
import type { Database } from "./db/database.js";
import type { Logger } from "./logger.js";
import type { EventBus } from "./events.js";
import type { AppPaths } from "./paths.js";

export interface PipelineDeps {
  db: Database;
  paths: AppPaths;
  logger: Logger;
  events: EventBus;
  stt: SttProvider;
  providers: Map<ProviderId, TextCorrectionProvider>;
  loadSystemPrompt: () => string;
}

export interface RunPipelineOptions {
  dictationId?: string;
  audio: Buffer;
  context: DictationContext;
  signal: AbortSignal;
}

interface Timings {
  sttMs?: number;
  llmMs?: number;
  totalMs: number;
}

/** Monotonic elapsed milliseconds — wall-clock jumps must not corrupt reported latency. */
function elapsedMs(from: bigint): number {
  return Number(process.hrtime.bigint() - from) / 1e6;
}

export class Pipeline {
  readonly #deps: PipelineDeps;
  readonly #inflight = new Map<string, AbortController>();

  constructor(deps: PipelineDeps) {
    this.#deps = deps;
  }

  /** Aborts an in-flight dictation. Returns false when there was nothing to cancel. */
  cancel(dictationId: string): boolean {
    const controller = this.#inflight.get(dictationId);
    if (!controller) return false;
    controller.abort();
    return true;
  }

  get inflightCount(): number {
    return this.#inflight.size;
  }

  async run(options: RunPipelineOptions): Promise<DictationOutcome> {
    const { db, paths, logger, events } = this.#deps;
    const settings = db.getSettings();
    const id = options.dictationId ?? `dct_${randomUUID()}`;
    const startedAt = process.hrtime.bigint();

    const controller = new AbortController();
    const onExternalAbort = () => controller.abort();
    options.signal.addEventListener("abort", onExternalAbort, { once: true });
    this.#inflight.set(id, controller);

    const log = logger.child({ dictationId: id });
    let audioPath: string | undefined;
    let recordCreated = false;

    try {
      events.publish({
        type: "pipeline",
        dictationId: id,
        stage: "received",
        status: "transcribing",
        at: new Date().toISOString(),
        detail: { bytes: options.audio.byteLength },
      });

      // --- 1. Persist the capture to a temp file the worker can read -------
      mkdirSync(paths.tmpDir, { recursive: true, mode: 0o700 });
      audioPath = join(paths.tmpDir, `${id}.wav`);
      writeFileSync(audioPath, options.audio, { mode: 0o600 });

      const audioDurationMs = options.context.audioDurationMs ?? 0;

      // A stray tap produces a fraction of a second of nothing. Drop it here so it never
      // reaches the model and never appears in history.
      if (audioDurationMs > 0 && audioDurationMs < settings.general.minRecordingMs) {
        log.info("capture discarded: too short", { audioDurationMs });
        return this.#cancelledOutcome(id, "audio_too_short", elapsedMs(startedAt));
      }

      const peak = options.context.peakAmplitude;
      if (peak !== undefined && peak < settings.stt.silenceThreshold) {
        log.info("capture discarded: silent", { peak });
        return this.#cancelledOutcome(id, "stt_no_speech", elapsedMs(startedAt));
      }

      // --- 2. Transcribe ---------------------------------------------------
      const terms = db.listEnabledTerms();
      const initialPrompt = buildSttInitialPrompt(terms, settings.stt.glossaryPromptLimit);

      events.publish({
        type: "pipeline",
        dictationId: id,
        stage: "transcribing",
        status: "transcribing",
        at: new Date().toISOString(),
      });

      const sttStart = process.hrtime.bigint();
      const sttResult = await this.#deps.stt.transcribe(
        {
          audioPath,
          language: settings.stt.language,
          initialPrompt,
          requestId: id,
        },
        controller.signal,
      );
      const sttMs = elapsedMs(sttStart);

      if (controller.signal.aborted) throw new PipelineError("cancelled", "cancelled by user");

      if (sttResult.noSpeech || sttResult.rawTranscript.trim().length === 0) {
        log.info("no speech detected", { audioDurationMs: sttResult.audioDurationMs, sttMs });
        return this.#cancelledOutcome(id, "stt_no_speech", elapsedMs(startedAt));
      }

      // Only now does the dictation become real enough to record.
      const record: DictationRecord = db.createDictation({
        id,
        status: "correcting",
        recordingMode: options.context.recordingMode,
        ...(options.context.appName ? { appName: options.context.appName } : {}),
        ...(options.context.bundleId ? { bundleId: options.context.bundleId } : {}),
        audioDurationMs: sttResult.audioDurationMs || audioDurationMs,
        warnings: sttResult.warnings,
      });
      recordCreated = true;
      void record;

      // --- 3. Deterministic glossary pass ---------------------------------
      const replacement = applyDeterministicReplacements(sttResult.rawTranscript, terms);

      db.updateDictation(id, {
        rawTranscript: sttResult.rawTranscript,
        detectedLanguage: sttResult.detectedLanguage ?? "",
        sttProvider: settings.stt.backend,
        sttModel: sttResult.model,
        sttLatencyMs: Math.round(sttMs),
      });

      events.publish({
        type: "pipeline",
        dictationId: id,
        stage: "transcribed",
        status: "correcting",
        at: new Date().toISOString(),
        detail: { sttMs: Math.round(sttMs), chars: sttResult.rawTranscript.length },
      });

      // --- 4. LLM correction ----------------------------------------------
      const profile = resolveProfile(
        options.context.bundleId,
        db.listAppProfiles(),
        settings.correction.profile,
      );

      const correctionResult = await this.#correctWithFallback({
        rawTranscript: replacement.text,
        detectedLanguage: sttResult.detectedLanguage ?? settings.stt.language,
        terms,
        profile,
        context: options.context,
        settings,
        signal: controller.signal,
        dictationId: id,
        log,
      });

      const totalMs = elapsedMs(startedAt);

      if (correctionResult.ok) {
        const warnings = [...sttResult.warnings, ...correctionResult.warnings];
        db.updateDictation(id, {
          status: "completed",
          finalText: correctionResult.finalText,
          llmProvider: correctionResult.provider,
          llmModel: correctionResult.model,
          llmEffort: correctionResult.effort,
          llmLatencyMs: Math.round(correctionResult.latencyMs),
          totalLatencyMs: Math.round(totalMs),
          warnings,
        });
        db.markPresetOk(correctionResult.provider, correctionResult.model, correctionResult.effort);

        await this.#retainOrDeleteAudio(id, audioPath, settings);
        audioPath = undefined;

        events.publish({
          type: "pipeline",
          dictationId: id,
          stage: "completed",
          status: "completed",
          at: new Date().toISOString(),
          detail: {
            sttMs: Math.round(sttMs),
            llmMs: Math.round(correctionResult.latencyMs),
            totalMs: Math.round(totalMs),
          },
        });

        log.info("dictation completed", {
          sttMs: Math.round(sttMs),
          llmMs: Math.round(correctionResult.latencyMs),
          totalMs: Math.round(totalMs),
          provider: correctionResult.provider,
          model: correctionResult.model,
          effort: correctionResult.effort,
          rawChars: sttResult.rawTranscript.length,
          finalChars: correctionResult.finalText.length,
        });

        return {
          id,
          status: "completed",
          text: correctionResult.finalText,
          isRawFallback: false,
          audioDurationMs: sttResult.audioDurationMs,
          sttLatencyMs: Math.round(sttMs),
          llmLatencyMs: Math.round(correctionResult.latencyMs),
          totalLatencyMs: Math.round(totalMs),
          warnings,
        };
      }

      // --- 5. LLM failed: keep the transcript, never lose the user's words --
      const error = correctionResult.error;

      // Escape during processing must insert nothing at all. Rethrow so the catch block
      // records this as cancelled rather than falling into the raw-transcript fallback.
      if (error.code === "cancelled" || controller.signal.aborted) {
        throw new PipelineError("cancelled", "cancelled by user");
      }

      const useRaw = settings.general.insertRawTranscriptWhenLlmFails;

      db.updateDictation(id, {
        status: "failed",
        finalText: useRaw ? replacement.text : "",
        llmProvider: settings.correction.provider,
        llmModel: settings.correction.model,
        llmEffort: settings.correction.effort,
        totalLatencyMs: Math.round(totalMs),
        errorCode: error.code,
        errorMessage: error.message,
        warnings: [...sttResult.warnings, ...correctionResult.warnings],
      });

      await this.#retainOrDeleteAudio(id, audioPath, settings);
      audioPath = undefined;

      events.publish({
        type: "pipeline",
        dictationId: id,
        stage: "failed",
        status: "failed",
        at: new Date().toISOString(),
        detail: { code: error.code, totalMs: Math.round(totalMs) },
      });

      log.warn("dictation failed at correction", {
        code: error.code,
        totalMs: Math.round(totalMs),
        rawChars: sttResult.rawTranscript.length,
      });

      return {
        id,
        status: "failed",
        ...(useRaw ? { text: replacement.text } : {}),
        isRawFallback: useRaw,
        audioDurationMs: sttResult.audioDurationMs,
        sttLatencyMs: Math.round(sttMs),
        totalLatencyMs: Math.round(totalMs),
        errorCode: error.code,
        errorMessage: error.message,
        warnings: correctionResult.warnings,
      };
    } catch (error) {
      const totalMs = elapsedMs(startedAt);
      const pipelineError =
        error instanceof PipelineError
          ? error
          : new PipelineError("internal", error instanceof Error ? error.message : String(error));

      const cancelled = pipelineError.code === "cancelled" || controller.signal.aborted;

      if (recordCreated) {
        db.updateDictation(id, {
          status: cancelled ? "cancelled" : "failed",
          totalLatencyMs: Math.round(totalMs),
          errorCode: pipelineError.code,
          errorMessage: pipelineError.message,
        });
      }

      events.publish({
        type: "pipeline",
        dictationId: id,
        stage: cancelled ? "cancelled" : "failed",
        status: cancelled ? "cancelled" : "failed",
        at: new Date().toISOString(),
        detail: { code: pipelineError.code, totalMs: Math.round(totalMs) },
      });

      log[cancelled ? "info" : "error"]("dictation ended without text", {
        code: pipelineError.code,
        totalMs: Math.round(totalMs),
      });

      return {
        id,
        status: cancelled ? "cancelled" : "failed",
        isRawFallback: false,
        totalLatencyMs: Math.round(totalMs),
        errorCode: pipelineError.code,
        errorMessage: pipelineError.message,
        warnings: [],
      };
    } finally {
      options.signal.removeEventListener("abort", onExternalAbort);
      this.#inflight.delete(id);
      if (audioPath) {
        rmSync(audioPath, { force: true });
      }
    }
  }

  #cancelledOutcome(id: string, code: string, totalMs: number): DictationOutcome {
    this.#deps.events.publish({
      type: "pipeline",
      dictationId: id,
      stage: "cancelled",
      status: "cancelled",
      at: new Date().toISOString(),
      detail: { code },
    });
    return {
      id,
      status: "cancelled",
      isRawFallback: false,
      totalLatencyMs: Math.round(totalMs),
      errorCode: code,
      warnings: [],
    };
  }

  async #retainOrDeleteAudio(
    id: string,
    audioPath: string,
    settings: Settings,
  ): Promise<void> {
    if (!settings.stt.storeAudio) {
      rmSync(audioPath, { force: true });
      return;
    }
    const dir = settings.stt.audioDirectory.trim() || this.#deps.paths.audioDir;
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const target = join(dir, `${id}.wav`);
    copyFileSync(audioPath, target);
    rmSync(audioPath, { force: true });
    this.#deps.db.updateDictation(id, { audioPath: target });
  }

  /**
   * Runs correction, optionally retrying once on a transient network error, and only
   * crossing to the fallback provider when the user explicitly turned that on — silently
   * moving a request to a second paid subscription would be a surprising charge.
   */
  async #correctWithFallback(params: {
    rawTranscript: string;
    detectedLanguage: string;
    terms: ReturnType<Database["listEnabledTerms"]>;
    profile: FormattingProfile;
    context: DictationContext;
    settings: Settings;
    signal: AbortSignal;
    dictationId: string;
    log: Logger;
  }): Promise<
    | {
        ok: true;
        finalText: string;
        provider: ProviderId;
        model: string;
        effort: string;
        latencyMs: number;
        warnings: string[];
      }
    | { ok: false; error: PipelineError; warnings: string[] }
  > {
    const { settings, log } = params;
    const warnings: string[] = [];

    const glossary = selectGlossary(
      params.terms,
      params.rawTranscript,
      settings.correction.glossaryMaxTerms,
    );
    if (glossary.omitted > 0) {
      warnings.push(`${glossary.omitted} glossary terms omitted to keep the prompt short`);
    }

    const input: CorrectionInput = {
      rawTranscript: params.rawTranscript,
      language: params.detectedLanguage,
      glossary: glossary.entries,
      profile: params.profile,
      ...(params.context.appName ? { appName: params.context.appName } : {}),
      ...(params.context.bundleId ? { bundleId: params.context.bundleId } : {}),
      ...(settings.correction.sendWindowTitle && params.context.windowTitle
        ? { windowTitle: params.context.windowTitle }
        : {}),
    };

    const systemPrompt = this.#deps.loadSystemPrompt();

    const attempts: Array<{ provider: ProviderId; model: string; effort: string }> = [
      {
        provider: settings.correction.provider,
        model: settings.correction.model,
        effort: settings.correction.effort,
      },
    ];
    if (settings.correction.fallbackProviderEnabled) {
      attempts.push({
        provider: settings.correction.fallbackProvider,
        model: settings.correction.fallbackModel,
        effort: settings.correction.fallbackEffort,
      });
    }

    let lastError: PipelineError = new PipelineError("llm_failed", "no provider attempted");

    for (const [index, attempt] of attempts.entries()) {
      const provider = this.#deps.providers.get(attempt.provider);
      if (!provider) {
        lastError = new PipelineError("llm_cli_missing", `unknown provider ${attempt.provider}`);
        continue;
      }
      if (index > 0) {
        warnings.push(`fell back to ${attempt.provider} after ${lastError.code}`);
        this.#deps.events.publish({
          type: "pipeline",
          dictationId: params.dictationId,
          stage: "correcting",
          status: "correcting",
          at: new Date().toISOString(),
          detail: { fallback: true, provider: attempt.provider },
        });
      } else {
        this.#deps.events.publish({
          type: "pipeline",
          dictationId: params.dictationId,
          stage: "correcting",
          status: "correcting",
          at: new Date().toISOString(),
          detail: { provider: attempt.provider, model: attempt.model },
        });
      }

      const config = {
        model: attempt.model,
        effort: attempt.effort,
        timeoutMs: settings.correction.timeoutMs,
        systemPrompt,
        disableThinking: settings.correction.disableThinking,
      };

      // At most two tries, and only when the first failure was a transient network one.
      for (let tryIndex = 0; tryIndex < 2; tryIndex += 1) {
        try {
          const result = await provider.correct(input, config, params.signal);
          return {
            ok: true,
            finalText: result.finalText.trim(),
            provider: result.provider,
            model: result.model,
            effort: result.effort,
            latencyMs: result.latencyMs,
            warnings: [...warnings, ...result.warnings],
          };
        } catch (error) {
          const pipelineError =
            error instanceof PipelineError
              ? error
              : new PipelineError("llm_failed", error instanceof Error ? error.message : String(error));
          lastError = pipelineError;

          if (pipelineError.code === "cancelled" || params.signal.aborted) {
            return { ok: false, error: new PipelineError("cancelled", "cancelled"), warnings };
          }
          if (!pipelineError.retryable || tryIndex === 1) break;

          log.warn("retrying correction after a transient network error", {
            provider: attempt.provider,
          });
          warnings.push("retried once after a network error");
        }
      }
    }

    return { ok: false, error: lastError, warnings };
  }

  /**
   * Re-runs correction on an already-stored raw transcript. Used by the history page,
   * so the user can compare models without re-recording.
   */
  async reprocess(
    dictationId: string,
    override: { provider?: string; model?: string; effort?: string; profile?: string },
  ): Promise<DictationRecord> {
    const { db } = this.#deps;
    const record = db.getDictation(dictationId);
    if (!record) throw new PipelineError("internal", `dictation ${dictationId} not found`);
    if (!record.rawTranscript || record.rawTranscript.trim().length === 0) {
      throw new PipelineError("internal", "this record has no raw transcript to reprocess");
    }

    const settings = db.getSettings();
    const terms = db.listEnabledTerms();
    const profile = (override.profile ??
      resolveProfile(record.bundleId, db.listAppProfiles(), settings.correction.profile)) as FormattingProfile;

    const providerId = (override.provider ?? settings.correction.provider) as ProviderId;
    const provider = this.#deps.providers.get(providerId);
    if (!provider) throw new PipelineError("llm_cli_missing", `unknown provider ${providerId}`);

    const model = override.model ?? settings.correction.model;
    const effort = override.effort ?? settings.correction.effort;

    const replacement = applyDeterministicReplacements(record.rawTranscript, terms);
    const glossary = selectGlossary(terms, replacement.text, settings.correction.glossaryMaxTerms);

    const input: CorrectionInput = {
      rawTranscript: replacement.text,
      language: record.detectedLanguage ?? settings.stt.language,
      glossary: glossary.entries,
      profile,
      ...(record.appName ? { appName: record.appName } : {}),
      ...(record.bundleId ? { bundleId: record.bundleId } : {}),
    };

    const controller = new AbortController();
    this.#inflight.set(dictationId, controller);
    try {
      const result = await provider.correct(
        {
          ...input,
        },
        {
          model,
          effort,
          timeoutMs: settings.correction.timeoutMs,
          systemPrompt: this.#deps.loadSystemPrompt(),
          disableThinking: settings.correction.disableThinking,
        },
        controller.signal,
      );

      db.markPresetOk(providerId, model, effort);

      return db.updateDictation(dictationId, {
        status: "completed",
        finalText: result.finalText.trim(),
        llmProvider: result.provider,
        llmModel: result.model,
        llmEffort: result.effort,
        llmLatencyMs: Math.round(result.latencyMs),
        totalLatencyMs: Math.round((record.sttLatencyMs ?? 0) + result.latencyMs),
        errorCode: "",
        errorMessage: "",
      })!;
    } finally {
      this.#inflight.delete(dictationId);
    }
  }
}

export type { Timings };
