import { z } from "zod";
import type { FormattingProfile, ProviderId } from "./settings.js";

// ---------------------------------------------------------------------------
// Speech-to-text
// ---------------------------------------------------------------------------

export interface SttHealth {
  ready: boolean;
  state: "starting" | "loading" | "ready" | "error" | "stopped";
  backend: string;
  model?: string;
  device?: string;
  /** Milliseconds the model took to load, once it has loaded. */
  loadMs?: number;
  warmedUp?: boolean;
  error?: string;
  restarts?: number;
}

export interface SttInput {
  /** Absolute path to a mono 16 kHz PCM WAV file readable by the worker. */
  audioPath: string;
  /** "auto" means let Whisper detect the language. */
  language: "auto" | "ru" | "en";
  /** Short glossary hint injected as the Whisper initial prompt. */
  initialPrompt?: string;
  requestId: string;
}

export interface SttResult {
  rawTranscript: string;
  detectedLanguage?: string;
  audioDurationMs: number;
  transcriptionMs: number;
  model: string;
  /** True when the audio contained no usable speech. */
  noSpeech: boolean;
  warnings: string[];
}

export interface SttProvider {
  health(): Promise<SttHealth>;
  transcribe(input: SttInput, signal?: AbortSignal): Promise<SttResult>;
}

// ---------------------------------------------------------------------------
// Text correction
// ---------------------------------------------------------------------------

export interface GlossaryEntry {
  canonical: string;
  aliases: string[];
}

export interface CorrectionInput {
  rawTranscript: string;
  language: string;
  glossary: GlossaryEntry[];
  profile: FormattingProfile;
  appName?: string;
  bundleId?: string;
  /** Only populated when the user explicitly enabled window-title sharing. */
  windowTitle?: string;
}

export interface ProviderConfig {
  model: string;
  effort: string;
  timeoutMs: number;
  /** Full system prompt text; never logged. */
  systemPrompt: string;
  /** Drop extended thinking where the CLI supports it. */
  disableThinking: boolean;
}

export interface CorrectionResult {
  finalText: string;
  provider: ProviderId;
  model: string;
  effort: string;
  latencyMs: number;
  /** CLI metadata with anything secret already stripped. */
  metadata: Record<string, unknown>;
  usage?: Record<string, unknown>;
  warnings: string[];
}

export interface ProviderHealth {
  id: ProviderId;
  available: boolean;
  cliPath?: string;
  version?: string;
  authenticated: boolean;
  authDetail?: string;
  /** Names of API-key env vars present in this process; values are never read out. */
  apiKeyEnvPresent: string[];
  /** Flags the installed CLI does not support, so doctor can explain the degradation. */
  missingFlags: string[];
  error?: string;
}

export interface TextCorrectionProvider {
  readonly id: ProviderId;
  health(): Promise<ProviderHealth>;
  correct(
    input: CorrectionInput,
    config: ProviderConfig,
    signal?: AbortSignal,
  ): Promise<CorrectionResult>;
}

// ---------------------------------------------------------------------------
// Structured output contract shared by both CLIs
// ---------------------------------------------------------------------------

export const CORRECTION_JSON_SCHEMA = {
  type: "object",
  properties: {
    text: { type: "string" },
  },
  required: ["text"],
  additionalProperties: false,
} as const;

export const CorrectionOutputSchema = z
  .object({ text: z.string() })
  .strict();

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export const ERROR_CODES = [
  "stt_unavailable",
  "stt_timeout",
  "stt_failed",
  "stt_no_speech",
  "audio_invalid",
  "audio_too_short",
  "llm_cli_missing",
  "llm_not_authenticated",
  "llm_model_unavailable",
  "llm_rate_limited",
  "llm_network",
  "llm_timeout",
  "llm_invalid_output",
  "llm_failed",
  "cancelled",
  "internal",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export class PipelineError extends Error {
  readonly code: ErrorCode;
  /** A transient network hiccup may be retried exactly once; nothing else is. */
  readonly retryable: boolean;

  constructor(code: ErrorCode, message: string, options?: { retryable?: boolean; cause?: unknown }) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "PipelineError";
    this.code = code;
    this.retryable = options?.retryable ?? false;
  }
}
