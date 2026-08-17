import type { PermissionState, ProviderHealth, SttHealth } from "@lvf/shared";

/**
 * Shapes the core returns that have no Zod schema in `@lvf/shared` yet (they are
 * described in `docs/API.md`). Every field the UI does not strictly need is optional
 * so a partially implemented core degrades into missing rows instead of a blank page.
 */

export interface ProviderPreset {
  id: string;
  provider: string;
  model: string;
  effort: string;
  label: string;
  builtin: boolean;
}

export interface ProviderPresetInput {
  provider: string;
  model: string;
  effort: string;
  label: string;
}

export interface GlossaryHit {
  alias: string;
  canonical: string;
  index: number;
}

export interface DictionaryPreview {
  rawTranscript: string;
  afterReplacements: string;
  hits: GlossaryHit[];
  skipped: string[];
  glossary: Array<{ canonical: string; aliases: string[] }>;
  sttInitialPrompt: string;
  promptPreview: string;
  profile: string;
}

export interface DictionaryImportResult {
  created: number;
  updated: number;
  skipped: number;
  duplicates?: string[];
}

export interface TestProviderResult {
  ok: boolean;
  latencyMs?: number;
  provider?: string;
  model?: string;
  sample?: string;
  error?: string;
}

export interface TestTranscriptionResult {
  ok?: boolean;
  transcript?: string;
  /** Older/alternate field name; the UI falls back to it. */
  text?: string;
  latencyMs?: number;
  transcriptionMs?: number;
  audioDurationMs?: number;
  model?: string;
  detectedLanguage?: string;
  path?: string;
  warnings?: string[];
  error?: string;
}

export type CheckLevel = "ok" | "warn" | "fail";

export interface DiagnosticCheck {
  id: string;
  label: string;
  level: CheckLevel;
  detail?: string;
  /** Concrete step the user can take, e.g. "Open System Settings → Privacy & Security". */
  action?: string;
}

/** Environment entry rendered in a command preview. Secrets arrive without a value. */
export interface EnvEntry {
  name: string;
  value?: string;
}

export interface CommandPreview {
  provider: string;
  label?: string;
  argv: string[];
  env?: EnvEntry[];
  /** Description of what goes to stdin — never the payload itself. */
  stdin?: string;
}

export interface DiagnosticsReport {
  generatedAt?: string;
  app?: { name?: string; version?: string; port?: number };
  system?: {
    macosVersion?: string;
    build?: string;
    arch?: string;
    cpu?: string;
    node?: string;
    python?: string;
    ffmpeg?: string;
  };
  core?: {
    status?: string;
    uptimeMs?: number;
    port?: number;
    sqliteWritable?: boolean;
    dataDirectory?: string;
    logsDirectory?: string;
    audioDirectory?: string;
    databasePath?: string;
  };
  stt?: SttHealth & { pythonPath?: string; workerPath?: string };
  providers?: ProviderHealth[];
  permissions?: {
    microphone: PermissionState;
    accessibility: PermissionState;
    inputMonitoring: PermissionState;
    reportedAt?: string;
    agentConnected: boolean;
    fnTapActive?: boolean;
    fnTapError?: string;
  };
  correction?: { provider: string; model: string; effort: string; profile: string };
  lastError?: { at: string; code: string; message: string };
  /** Names only — values are never sent by core and must never be rendered. */
  apiKeyEnvPresent?: string[];
  /** When core computes the doctor rows itself they win over the client-side ones. */
  checks?: DiagnosticCheck[];
  /** When core exposes the real argv it wins over the reconstructed preview. */
  commandPreview?: CommandPreview[];
}

/** Optional capability endpoint; the UI falls back to `@lvf/shared` when it is absent. */
export interface ProviderCapability {
  id: string;
  label?: string;
  efforts: string[];
  models?: string[];
  available?: boolean;
}

export interface HistoryPage {
  items: import("@lvf/shared").DictationRecord[];
  total: number;
}
