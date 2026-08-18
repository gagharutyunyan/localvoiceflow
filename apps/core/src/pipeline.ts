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

/** Monotonic elapsed milliseconds — wall-clock jumps must not corrupt reported latency. */
function elapsedMs(from: bigint): number {
  return Number(process.hrtime.bigint() - from) / 1e6;
}

/** One (provider, model, effort) combination the correction step may try. */
interface AttemptPreset {
  provider: ProviderId;
  model: string;
  effort: string;
  disableThinking: boolean;
}

/**
 * The presets one dictation may be tried against, in order.
 *
 * A fallback identical to the primary is dropped: repeating the same model with the same
 * effort is not a fallback, it is the same call again, and the retry loop already covers
 * that case with a shorter wait.
 */
function buildAttemptPresets(settings: Settings): AttemptPreset[] {
  const { correction } = settings;
  const presets: AttemptPreset[] = [
    {
      provider: correction.provider,
      model: correction.model,
      effort: correction.effort,
      disableThinking: correction.disableThinking,
    },
  ];

  if (correction.fallbackProviderEnabled) {
    const fallback: AttemptPreset = {
      provider: correction.fallbackProvider,
      model: correction.fallbackModel,
      effort: correction.fallbackEffort,
      disableThinking: correction.fallbackDisableThinking,
    };
    const sameAsPrimary =
      fallback.provider === presets[0]!.provider &&
      fallback.model === presets[0]!.model &&
      fallback.effort === presets[0]!.effort &&
      fallback.disableThinking === presets[0]!.disableThinking;
    if (!sameAsPrimary) presets.push(fallback);
  }

  return presets;
}

/**
 * How far a failed attempt invalidates the attempts planned after it.
 *
 *  - `retry`     the same preset is worth another go — a network blip, a mangled JSON
 *                envelope, a CLI that died on its own.
 *  - `preset`    this preset is spent but another may still work: it timed out, it was
 *                rate-limited, this subscription has no such model. Retrying a preset
 *                that just burned a full timeout only spends the budget twice.
 *  - `provider`  nothing on this provider can work right now (signed out, CLI not
 *                installed), so every remaining preset that uses it is skipped as well.
 */
type FailureScope = "retry" | "preset" | "provider";

function failureScope(error: PipelineError): FailureScope {
  switch (error.code) {
    case "llm_network":
    case "llm_invalid_output":
    case "llm_failed":
      return "retry";
    case "llm_not_authenticated":
    case "llm_cli_missing":
      return "provider";
    default:
      return "preset";
  }
}

/** Abortable sleep: Esc during a retry backoff must not cost the user a full delay. */
function delay(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0 || signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
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

  /**
   * Aborts every in-flight dictation and returns how many were signalled. Called on
   * shutdown before the server drains, so CLI children and STT requests are torn down
   * instead of being orphaned when the process exits.
   */
  cancelAll(): number {
    let aborted = 0;
    for (const controller of this.#inflight.values()) {
      controller.abort();
      aborted += 1;
    }
    return aborted;
  }

  isInflight(dictationId: string): boolean {
    return this.#inflight.has(dictationId);
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
    let prewarmedProvider: TextCorrectionProvider | undefined;

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
      // The suffix keeps the temp path unique even if a client reuses a dictation id, so
      // one capture can never overwrite another's audio mid-flight.
      audioPath = join(paths.tmpDir, `${id}-${randomUUID()}.wav`);
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

      // Start the corrector CLI now so its startup overlaps transcription. The child
      // blocks on stdin — nothing is sent and no quota is spent unless the correction
      // step consumes it; the finally below reaps it on every other path.
      prewarmedProvider = this.#deps.providers.get(settings.correction.provider);
      prewarmedProvider?.prewarm?.({
        model: settings.correction.model,
        effort: settings.correction.effort,
        timeoutMs: settings.correction.timeoutMs,
        systemPrompt: this.#deps.loadSystemPrompt(),
        disableThinking: settings.correction.disableThinking,
      });

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
        // The glossary-substituted transcript, i.e. what the LLM is about to receive.
        text: replacement.text,
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
      // Guarded delete: with a reused id, an earlier run finishing must not evict the
      // newer run's controller, or that run would become uncancellable.
      if (this.#inflight.get(id) === controller) this.#inflight.delete(id);
      if (audioPath) {
        rmSync(audioPath, { force: true });
      }
      // Reap a prewarmed CLI child the correction step never consumed (no speech, too
      // short, cancel, STT failure). A parallel dictation's fresh prewarm can be caught
      // by this too — that run then simply cold-spawns; never incorrect, only unwarmed.
      prewarmedProvider?.cancelPrewarm?.();
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
   * Runs the correction step, retrying and falling back until something works or the
   * attempt budget is spent.
   *
   * One LLM call used to be the whole policy — a retry only for a network blip, and a
   * single shot at the fallback. Anything else (a CLI that died, a mangled envelope, a
   * model that thought for longer than its timeout) dropped the dictation onto the raw
   * transcript on the first stumble. Now every preset gets its own attempts, the failure
   * decides how far to jump, and the total is bounded by `correction.maxAttempts` so a
   * bad run still cannot outlive the budget the agent is waiting on.
   *
   * Crossing to the fallback provider still requires the user to have turned it on —
   * silently moving a request onto a second paid subscription would be a surprising charge.
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
    const presets = buildAttemptPresets(settings);
    // Every preset gets a share of the budget, so a fallback that was configured always
    // gets to run even when the primary burns retries first.
    const perPreset = Math.max(1, Math.ceil(settings.correction.maxAttempts / presets.length));

    let lastError: PipelineError = new PipelineError("llm_failed", "no provider attempted");
    const deadProviders = new Set<ProviderId>();
    let attemptsUsed = 0;

    for (const [index, preset] of presets.entries()) {
      if (attemptsUsed >= settings.correction.maxAttempts) break;
      if (deadProviders.has(preset.provider)) {
        log.debug("skipping preset on a provider that already failed hard", {
          provider: preset.provider,
          model: preset.model,
        });
        continue;
      }

      const provider = this.#deps.providers.get(preset.provider);
      if (!provider) {
        lastError = new PipelineError("llm_cli_missing", `unknown provider ${preset.provider}`);
        continue;
      }

      const config = {
        model: preset.model,
        effort: preset.effort,
        timeoutMs: settings.correction.timeoutMs,
        systemPrompt,
        disableThinking: preset.disableThinking,
      };

      let scope: FailureScope = "retry";

      for (let tryIndex = 0; tryIndex < perPreset; tryIndex += 1) {
        if (attemptsUsed >= settings.correction.maxAttempts) break;
        if (params.signal.aborted) {
          return { ok: false, error: new PipelineError("cancelled", "cancelled"), warnings };
        }

        if (index > 0 && tryIndex === 0) {
          warnings.push(`fell back to ${preset.provider}/${preset.model} after ${lastError.code}`);
        }
        this.#deps.events.publish({
          type: "pipeline",
          dictationId: params.dictationId,
          stage: "correcting",
          status: "correcting",
          at: new Date().toISOString(),
          detail: {
            provider: preset.provider,
            model: preset.model,
            attempt: attemptsUsed + 1,
            of: settings.correction.maxAttempts,
            ...(index > 0 ? { fallback: true } : {}),
          },
        });

        attemptsUsed += 1;
        try {
          const result = await provider.correct(input, config, params.signal);
          const finalText = result.finalText.trim();
          // An empty reply is a failure wearing a success costume: the words went in and
          // nothing came back. Treated as success it silently swallowed the whole
          // dictation — the HUD closed, nothing was pasted, and history stored a blank.
          if (finalText.length === 0) {
            throw new PipelineError(
              "llm_invalid_output",
              `${preset.provider} returned an empty correction for a ${params.rawTranscript.length}-character transcript`,
            );
          }
          return {
            ok: true,
            finalText,
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

          scope = failureScope(pipelineError);
          log.warn("correction attempt failed", {
            provider: preset.provider,
            model: preset.model,
            attempt: attemptsUsed,
            code: pipelineError.code,
            scope,
          });
          if (scope !== "retry") break;

          const isLastTry =
            tryIndex === perPreset - 1 || attemptsUsed >= settings.correction.maxAttempts;
          if (isLastTry) break;

          warnings.push(`retried ${preset.model} after ${pipelineError.code}`);
          // Exponential: a provider that just refused a request is more likely to accept
          // the next one after a pause than immediately.
          await delay(settings.correction.retryBackoffMs * 2 ** tryIndex, params.signal);
        }
      }

      if (scope === "provider") deadProviders.add(preset.provider);
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
    // A second registration for a busy id would overwrite the live controller in
    // #inflight: cancel()/cancelAll() would then abort only the newcomer while the
    // now-invisible run kept going, wrote its result after the cancellation and its CLI
    // child outlived shutdown. Only synchronous code separates this check from the
    // registration below, so the check cannot race.
    if (this.#inflight.has(dictationId)) {
      throw new PipelineError("internal", `dictation ${dictationId} is still being processed`);
    }
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

      const finalText = result.finalText.trim();
      // Same rule as the live pipeline: an empty reply is not a correction. Storing it
      // would overwrite a perfectly good previous result with nothing.
      if (finalText.length === 0) {
        throw new PipelineError("llm_invalid_output", `${providerId} returned an empty correction`);
      }

      db.markPresetOk(providerId, model, effort);

      return db.updateDictation(dictationId, {
        status: "completed",
        finalText,
        llmProvider: result.provider,
        llmModel: result.model,
        llmEffort: result.effort,
        llmLatencyMs: Math.round(result.latencyMs),
        totalLatencyMs: Math.round((record.sttLatencyMs ?? 0) + result.latencyMs),
        errorCode: "",
        errorMessage: "",
      })!;
    } finally {
      if (this.#inflight.get(dictationId) === controller) this.#inflight.delete(dictationId);
    }
  }
}
