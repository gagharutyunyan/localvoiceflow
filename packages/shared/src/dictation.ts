import { z } from "zod";
import { DictationStatusSchema, RecordingModeSchema } from "./settings.js";

export const DictationRecordSchema = z.object({
  id: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  status: DictationStatusSchema,

  appName: z.string().optional(),
  bundleId: z.string().optional(),

  recordingMode: RecordingModeSchema,
  audioDurationMs: z.number().optional(),

  rawTranscript: z.string().optional(),
  finalText: z.string().optional(),
  detectedLanguage: z.string().optional(),

  sttProvider: z.string().optional(),
  sttModel: z.string().optional(),

  llmProvider: z.string().optional(),
  llmModel: z.string().optional(),
  llmEffort: z.string().optional(),

  sttLatencyMs: z.number().optional(),
  llmLatencyMs: z.number().optional(),
  totalLatencyMs: z.number().optional(),

  audioPath: z.string().optional(),
  errorCode: z.string().optional(),
  errorMessage: z.string().optional(),

  /** Non-fatal notes surfaced in the UI (silence trimmed, fallback used, ...). */
  warnings: z.array(z.string()).optional(),
});

export type DictationRecord = z.infer<typeof DictationRecordSchema>;

/** Metadata the macOS agent sends alongside the WAV body. */
export const DictationContextSchema = z.object({
  recordingMode: RecordingModeSchema.default("push-to-talk"),
  appName: z.string().max(200).optional(),
  bundleId: z.string().max(200).optional(),
  windowTitle: z.string().max(500).optional(),
  pid: z.number().int().optional(),
  audioDurationMs: z.number().min(0).optional(),
  /**
   * Peak amplitude measured by the agent; used to reject silent captures early.
   *
   * Deliberately unbounded above: Core Audio hands out Float32 samples that legitimately
   * overshoot 1.0 on some input devices (a boosted USB mic, AGC), and the longer the
   * capture the likelier one such sample is. An upper bound here used to reject the whole
   * upload with a 400 and throw the recording away — over a number that only ever feeds a
   * silence heuristic.
   */
  peakAmplitude: z.number().min(0).optional(),
  /** Client-side monotonic timestamp of the moment recording stopped, in ms since boot. */
  clientStopUptimeMs: z.number().optional(),
});

export type DictationContext = z.infer<typeof DictationContextSchema>;

export const HistoryQuerySchema = z.object({
  q: z.string().max(500).optional(),
  status: DictationStatusSchema.optional(),
  bundleId: z.string().max(200).optional(),
  llmProvider: z.string().max(80).optional(),
  llmModel: z.string().max(200).optional(),
  /** ISO-8601 inclusive lower bound. */
  from: z.string().max(40).optional(),
  /** ISO-8601 exclusive upper bound. */
  to: z.string().max(40).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(50),
  offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
});

export type HistoryQuery = z.infer<typeof HistoryQuerySchema>;

export const ReprocessRequestSchema = z.object({
  provider: z.string().max(40).optional(),
  model: z.string().max(120).optional(),
  effort: z.string().max(32).optional(),
  profile: z.string().max(32).optional(),
});
export type ReprocessRequest = z.infer<typeof ReprocessRequestSchema>;

/** Result the macOS agent acts on: what to insert, and how. */
export const DictationOutcomeSchema = z.object({
  id: z.string(),
  status: DictationStatusSchema,
  /** Text the agent should insert; absent when nothing should be inserted. */
  text: z.string().optional(),
  /** True when `text` is the uncorrected transcript because the LLM failed. */
  isRawFallback: z.boolean().default(false),
  audioDurationMs: z.number().optional(),
  sttLatencyMs: z.number().optional(),
  llmLatencyMs: z.number().optional(),
  totalLatencyMs: z.number().optional(),
  errorCode: z.string().optional(),
  errorMessage: z.string().optional(),
  warnings: z.array(z.string()).default([]),
});

export type DictationOutcome = z.infer<typeof DictationOutcomeSchema>;
