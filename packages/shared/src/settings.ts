import { z } from "zod";

/**
 * Model IDs are free-form so a new model can be used without shipping a new build,
 * but they are still validated as bounded, shell-safe-looking identifiers because
 * they end up in an argv array passed to a CLI.
 */
export const ModelIdSchema = z
  .string()
  .trim()
  .min(1, "model id must not be empty")
  .max(120, "model id must be at most 120 characters")
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9._:@/+-]*$/,
    "model id may only contain letters, digits and . _ : @ / + -",
  );

export const ProviderIdSchema = z.enum(["claude-cli", "openai-codex-cli", "local-mlx", "mock"]);
export type ProviderId = z.infer<typeof ProviderIdSchema>;

/**
 * On-device correction models (MLX repo ids) offered as presets. Free-form ids are
 * still accepted — any MLX chat model the machine can hold will work.
 *
 * Qwen3-4B is the default: measured on an M1 Pro it edits a short phrase in ~0.9 s
 * and a paragraph in ~2.3 s with solid Russian quality, while the 1.7B tier loses
 * content on long dictations and misses glossary substitutions.
 */
export const LOCAL_MLX_MODELS = [
  "mlx-community/Qwen3-4B-Instruct-2507-4bit",
  "mlx-community/Qwen3-8B-4bit",
] as const;
export const DEFAULT_LOCAL_MLX_MODEL = LOCAL_MLX_MODELS[0];

/**
 * Effort values accepted by the installed CLIs.
 *
 * Claude Code 2.1.234 `--effort`: low | medium | high | xhigh | max
 * Codex 0.147.0 `model_reasoning_effort` (per the server's own error message for
 * gpt-5.6-luna): none | low | medium | high | xhigh | max  — note there is NO "minimal".
 */
export const CLAUDE_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export const CODEX_EFFORTS = ["none", "low", "medium", "high", "xhigh", "max"] as const;

export const EffortSchema = z
  .string()
  .trim()
  .min(1)
  .max(32)
  .regex(/^[a-z][a-z0-9_-]*$/, "effort must be a lowercase identifier");

export const FormattingProfileSchema = z.enum(["minimal", "smart", "structured", "developer"]);
export type FormattingProfile = z.infer<typeof FormattingProfileSchema>;

export const SttLanguageSchema = z.enum(["auto", "ru", "en"]);
export type SttLanguage = z.infer<typeof SttLanguageSchema>;

export const TargetChangedBehaviorSchema = z.enum([
  "paste-only-if-same-app",
  "paste-into-current-app",
  "clipboard-only",
]);
export type TargetChangedBehavior = z.infer<typeof TargetChangedBehaviorSchema>;

export const RecordingModeSchema = z.enum(["push-to-talk", "locked"]);
export type RecordingMode = z.infer<typeof RecordingModeSchema>;

export const DictationStatusSchema = z.enum([
  "recording",
  "transcribing",
  "correcting",
  "completed",
  "failed",
  "cancelled",
]);
export type DictationStatus = z.infer<typeof DictationStatusSchema>;

export const GeneralSettingsSchema = z.object({
  enabled: z.boolean().default(true),
  startAtLogin: z.boolean().default(false),
  launchDashboardOnStart: z.boolean().default(false),
  hudEnabled: z.boolean().default(true),
  soundFeedbackEnabled: z.boolean().default(false),
  /** Carbon virtual keycode + modifier mask, rendered human-readably in the UI. */
  fallbackHotkeyEnabled: z.boolean().default(true),
  fallbackHotkey: z.string().trim().max(64).default("control+option+space"),
  /** Standalone Fn as the primary push-to-talk trigger. */
  fnTriggerEnabled: z.boolean().default(true),
  doubleTapWindowMs: z.number().int().min(120).max(1000).default(350),
  /** A press shorter than this never produces a history record. */
  minRecordingMs: z.number().int().min(0).max(5000).default(350),
  maxRecordingSeconds: z.number().int().min(5).max(1800).default(180),
  endLockedRecordingWithEnter: z.boolean().default(false),
  targetChangedBehavior: TargetChangedBehaviorSchema.default("paste-only-if-same-app"),
  insertRawTranscriptWhenLlmFails: z.boolean().default(true),
  /** Restore the previous clipboard after a ⌘V paste, when it is still ours. */
  restoreClipboardAfterPaste: z.boolean().default(true),
  clipboardRestoreDelayMs: z.number().int().min(50).max(5000).default(600),
});

export const SttSettingsSchema = z.object({
  backend: z.enum(["mlx-whisper", "mock"]).default("mlx-whisper"),
  model: z.string().trim().min(1).max(200).default("mlx-community/whisper-large-v3-turbo"),
  language: SttLanguageSchema.default("ru"),
  warmUpOnStart: z.boolean().default(true),
  storeAudio: z.boolean().default(false),
  audioDirectory: z.string().trim().max(1024).default(""),
  /** Hard cap on the characters of glossary injected into the Whisper initial prompt. */
  glossaryPromptLimit: z.number().int().min(0).max(896).default(220),
  timeoutMs: z.number().int().min(1000).max(600_000).default(120_000),
  /** Below this peak amplitude the capture is considered silent and dropped. */
  silenceThreshold: z.number().min(0).max(1).default(0.008),
});

export const TextCorrectionSettingsSchema = z.object({
  provider: ProviderIdSchema.default("claude-cli"),
  model: ModelIdSchema.default("haiku"),
  effort: EffortSchema.default("low"),
  profile: FormattingProfileSchema.default("smart"),
  /** Empty means "use prompts/transcription-editor.md as shipped". */
  customSystemPrompt: z.string().max(20_000).default(""),
  /** Per-attempt budget. The whole correction step may cost this much per LLM call. */
  timeoutMs: z.number().int().min(1000).max(300_000).default(30_000),
  /**
   * How many LLM calls one dictation may cost in total, across the primary preset and
   * the fallback. A single attempt used to mean one flaky call lost the correction and
   * dropped the user onto the raw transcript.
   */
  maxAttempts: z.number().int().min(1).max(6).default(3),
  /** Delay before retrying the same preset; doubled on each further retry. */
  retryBackoffMs: z.number().int().min(0).max(10_000).default(400),
  fallbackProviderEnabled: z.boolean().default(false),
  fallbackProvider: ProviderIdSchema.default("openai-codex-cli"),
  fallbackModel: ModelIdSchema.default("gpt-5.6-luna"),
  fallbackEffort: EffortSchema.default("none"),
  /**
   * The fallback exists to rescue a dictation that the primary preset already spent its
   * budget on, so it runs without extended thinking regardless of the primary's setting —
   * a second slow, thinking run is exactly what the fallback is there to avoid.
   */
  fallbackDisableThinking: z.boolean().default(true),
  /** Number of glossary terms selected as relevant for one correction request. */
  glossaryMaxTerms: z.number().int().min(0).max(200).default(40),
  /** Off by default: the window title can leak sensitive content to the provider. */
  sendWindowTitle: z.boolean().default(false),
  /** Disable extended thinking in Claude Code — measured 4x faster, same edit quality. */
  disableThinking: z.boolean().default(true),
});


export const PrivacySettingsSchema = z.object({
  logLevel: z.enum(["error", "warn", "info", "debug"]).default("info"),
});

/**
 * The effort must be one the selected provider actually accepts.
 *
 * This is checked on the merged settings rather than inside `TextCorrectionSettingsSchema`,
 * for two reasons: a PATCH that changes only `effort` carries no `provider` to validate
 * against, and `.partial()` (used to build the patch schema) is unavailable once a schema
 * carries a refinement. Validating the merged result covers both the full PUT and the
 * partial PATCH with one rule.
 *
 * Without it, a plausible-looking value such as "minimal" — which neither CLI supports —
 * was stored happily and only surfaced later as a failed dictation with an opaque CLI
 * error. Rejecting it here turns that into an immediate, specific 400.
 */
export const SettingsSchema = z
  .object({
    general: GeneralSettingsSchema.default({}),
    stt: SttSettingsSchema.default({}),
    correction: TextCorrectionSettingsSchema.default({}),
    privacy: PrivacySettingsSchema.default({}),
  })
  .superRefine((value, ctx) => {
    const checks = [
      {
        provider: value.correction.provider,
        model: value.correction.model,
        effort: value.correction.effort,
        disableThinking: value.correction.disableThinking,
        key: "effort",
      },
      {
        provider: value.correction.fallbackProvider,
        model: value.correction.fallbackModel,
        effort: value.correction.fallbackEffort,
        disableThinking: value.correction.fallbackDisableThinking,
        key: "fallbackEffort",
      },
    ] as const;
    for (const { provider, model, effort, disableThinking, key } of checks) {
      // "mock" exists only for tests and accepts whatever it is given.
      if (provider === "mock") continue;
      const allowed = knownEffortsFor(provider);
      if (!allowed.includes(effort)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["correction", key],
          message: `"${effort}" is not a valid effort for ${provider}; expected one of: ${allowed.join(", ")}`,
        });
        continue;
      }
      if (provider === "claude-cli" && !effortWorksWithoutThinking(model, effort, disableThinking)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["correction", key],
          message: `Opus rejects effort "${effort}" while thinking is disabled ("output_config.effort ... is not supported when thinking is disabled on this model"). Use "high" or below, or turn thinking back on.`,
        });
      }
    }
  });

/**
 * Whether a Claude preset can run with extended thinking switched off.
 *
 * Opus answers `400 output_config.effort '<x>' is not supported when thinking is disabled
 * on this model` for the top two efforts — instantly, before any tokens are spent, so the
 * only symptom is that every dictation fails. Haiku and Sonnet accept the same
 * combination (verified against Claude Code 2.1.234), which is why this is keyed on the
 * model id rather than on the effort alone.
 */
export function effortWorksWithoutThinking(
  model: string,
  effort: string,
  disableThinking: boolean,
): boolean {
  if (!disableThinking) return true;
  if (!/opus/i.test(model)) return true;
  return effort !== "xhigh" && effort !== "max";
}

export type Settings = z.infer<typeof SettingsSchema>;
export type GeneralSettings = Settings["general"];
export type SttSettings = Settings["stt"];
export type TextCorrectionSettings = Settings["correction"];

/** A deep-partial patch accepted by `PATCH /api/settings`. */
export const SettingsPatchSchema = z
  .object({
    general: GeneralSettingsSchema.partial().optional(),
    stt: SttSettingsSchema.partial().optional(),
    correction: TextCorrectionSettingsSchema.partial().optional(),
    privacy: PrivacySettingsSchema.partial().optional(),
  })
  .strict();

export type SettingsPatch = z.infer<typeof SettingsPatchSchema>;

export function defaultSettings(): Settings {
  return SettingsSchema.parse({});
}

/**
 * Worst-case wall time one dictation may occupy, end to end.
 *
 * The macOS agent uses this as its HTTP timeout for `POST /api/dictations`, so it must
 * bound everything the pipeline can legitimately spend: transcription, then up to
 * `maxAttempts` LLM calls of `timeoutMs` each, plus the backoff between them and slack
 * for spawning CLIs and writing the record. A client timeout below this number is the
 * one failure mode that loses a finished dictation — the core answers into a socket
 * nobody is listening on any more.
 */
export function dictationBudgetMs(settings: Settings): number {
  const { correction, stt } = settings;
  const backoff = correction.retryBackoffMs * Math.max(0, correction.maxAttempts - 1) * 2;
  const budget = stt.timeoutMs + correction.timeoutMs * correction.maxAttempts + backoff + 20_000;
  return Math.min(budget, 900_000);
}

/** Effort values the installed CLI is known to accept, for UI presets and validation hints. */
export function knownEffortsFor(provider: ProviderId): readonly string[] {
  switch (provider) {
    case "claude-cli":
      return CLAUDE_EFFORTS;
    case "openai-codex-cli":
      return CODEX_EFFORTS;
    case "local-mlx":
      // No reasoning-effort knob on a plain instruct model; a single value keeps the
      // effort validation and the UI honest.
      return ["low"];
    default:
      return ["low"];
  }
}
