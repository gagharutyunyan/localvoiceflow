import type {
  AppProfile,
  DictationRecord,
  DictionaryImport,
  DictionaryTerm,
  DictionaryTermInput,
  DictionaryTermPatch,
  ReprocessRequest,
  Settings,
  SettingsPatch,
  StatusResponse,
} from "@lvf/shared";
import type {
  DiagnosticsReport,
  DictionaryImportResult,
  DictionaryPreview,
  HistoryPage,
  ProviderCapability,
  ProviderPreset,
  ProviderPresetInput,
  TestProviderResult,
  TestTranscriptionResult,
} from "./types";

/**
 * Error carrying the `{ code, message }` pair core returns for every failure.
 * Codes produced by the client itself (no response, unparseable body) are prefixed
 * with `client_` so they can never be confused with a core `ERROR_CODES` value.
 */
export class ApiError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status = 0) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = status;
  }
}

export function isApiError(value: unknown): value is ApiError {
  return value instanceof ApiError;
}

export function errorMessage(error: unknown): string {
  if (isApiError(error)) return `${error.message} (${error.code})`;
  if (error instanceof Error) return error.message;
  return String(error);
}

export type QueryValue = string | number | boolean | undefined | null;

interface RequestOptions {
  method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  body?: unknown;
  query?: Record<string, QueryValue>;
  signal?: AbortSignal;
  /** Set for endpoints that legitimately answer with an empty body. */
  expectEmpty?: boolean;
}

export function buildUrl(path: string, query?: Record<string, QueryValue>): string {
  if (!query) return path;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === "") continue;
    params.set(key, String(value));
  }
  const qs = params.toString();
  return qs ? `${path}?${qs}` : path;
}

function parseErrorBody(raw: string, status: number): ApiError {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && "error" in parsed) {
      const err = (parsed as { error?: unknown }).error;
      if (err && typeof err === "object") {
        const code = (err as { code?: unknown }).code;
        const message = (err as { message?: unknown }).message;
        return new ApiError(
          typeof code === "string" ? code : "client_http_error",
          typeof message === "string" ? message : `Request failed with status ${status}`,
          status,
        );
      }
    }
  } catch {
    // Non-JSON error body (a static-file 404, a proxy page) — fall through.
  }
  const trimmed = raw.trim().slice(0, 300);
  return new ApiError(
    "client_http_error",
    trimmed.length > 0 ? trimmed : `Request failed with status ${status}`,
    status,
  );
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const method = options.method ?? "GET";
  const init: RequestInit = {
    method,
    credentials: "same-origin",
    headers: { Accept: "application/json" },
    ...(options.signal ? { signal: options.signal } : {}),
  };

  if (options.body !== undefined) {
    init.headers = { ...(init.headers as Record<string, string>), "Content-Type": "application/json" };
    init.body = JSON.stringify(options.body);
  }

  let response: Response;
  try {
    response = await fetch(buildUrl(path, options.query), init);
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === "AbortError") throw cause;
    throw new ApiError(
      "client_network",
      "Cannot reach the LocalVoiceFlow service on 127.0.0.1. Is it running?",
    );
  }

  if (!response.ok) {
    throw parseErrorBody(await response.text(), response.status);
  }

  if (options.expectEmpty || response.status === 204) return undefined as T;

  const text = await response.text();
  if (text.length === 0) return undefined as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new ApiError("client_invalid_response", "The service returned a malformed JSON body.", response.status);
  }
}

/** Used by the local-data export, which stitches several endpoints together. */
async function requestText(path: string, signal?: AbortSignal): Promise<string> {
  let response: Response;
  try {
    response = await fetch(path, {
      credentials: "same-origin",
      ...(signal ? { signal } : {}),
    });
  } catch {
    throw new ApiError("client_network", `Cannot reach ${path}.`);
  }
  if (!response.ok) throw parseErrorBody(await response.text(), response.status);
  return response.text();
}

export interface HistoryFilters {
  q?: string;
  status?: string;
  bundleId?: string;
  llmProvider?: string;
  llmModel?: string;
  from?: string;
  to?: string;
  limit?: number;
  offset?: number;
}

export interface HealthResponse {
  ok: boolean;
  version: string;
  uptimeMs: number;
}

export const api = {
  health: (signal?: AbortSignal) => request<HealthResponse>("/api/health", { signal }),

  status: (signal?: AbortSignal) => request<StatusResponse>("/api/status", { signal }),

  // -- history ------------------------------------------------------------
  listDictations: (filters: HistoryFilters, signal?: AbortSignal) =>
    request<HistoryPage>("/api/dictations", { query: { ...filters }, signal }),

  getDictation: (id: string, signal?: AbortSignal) =>
    request<DictationRecord>(`/api/dictations/${encodeURIComponent(id)}`, { signal }),

  updateDictation: (id: string, finalText: string) =>
    request<DictationRecord>(`/api/dictations/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: { finalText },
    }),

  deleteDictation: (id: string) =>
    request<void>(`/api/dictations/${encodeURIComponent(id)}`, { method: "DELETE", expectEmpty: true }),

  deleteDictations: (ids: string[]) =>
    request<{ deleted: number }>("/api/dictations/delete", { method: "POST", body: { ids } }),

  clearHistory: () =>
    request<{ deleted: number }>("/api/dictations", { method: "DELETE", query: { confirm: "yes" } }),

  /**
   * Not in docs/API.md yet: removes stored WAV files while keeping the transcripts.
   * A 404/405 is surfaced to the user as "not supported by this core build".
   */
  deleteStoredAudio: () =>
    request<{ deleted: number }>("/api/dictations/audio", { method: "DELETE", query: { confirm: "yes" } }),

  reprocess: (id: string, body: ReprocessRequest) =>
    request<DictationRecord>(`/api/dictations/${encodeURIComponent(id)}/reprocess`, {
      method: "POST",
      body,
    }),

  dictationExportUrl: (format: "json" | "csv") => buildUrl("/api/dictations/export", { format }),

  dictationExportText: (format: "json" | "csv", signal?: AbortSignal) =>
    requestText(buildUrl("/api/dictations/export", { format }), signal),

  dictationAudioUrl: (id: string) => `/api/dictations/${encodeURIComponent(id)}/audio`,

  // -- dictionary ---------------------------------------------------------
  listDictionary: (signal?: AbortSignal) =>
    request<{ items: DictionaryTerm[] }>("/api/dictionary", { signal }),

  createTerm: (input: DictionaryTermInput) =>
    request<DictionaryTerm>("/api/dictionary", { method: "POST", body: input }),

  updateTerm: (id: string, patch: DictionaryTermPatch) =>
    request<DictionaryTerm>(`/api/dictionary/${encodeURIComponent(id)}`, { method: "PATCH", body: patch }),

  deleteTerm: (id: string) =>
    request<void>(`/api/dictionary/${encodeURIComponent(id)}`, { method: "DELETE", expectEmpty: true }),

  bulkSetEnabled: (ids: string[], enabled: boolean) =>
    request<{ updated: number }>("/api/dictionary/bulk", { method: "POST", body: { ids, enabled } }),

  importDictionary: (payload: DictionaryImport) =>
    request<DictionaryImportResult>("/api/dictionary/import", { method: "POST", body: payload }),

  dictionaryExportUrl: (format: "json" | "csv") => buildUrl("/api/dictionary/export", { format }),

  dictionaryExportText: (format: "json" | "csv", signal?: AbortSignal) =>
    requestText(buildUrl("/api/dictionary/export", { format }), signal),

  previewDictionary: (body: { rawTranscript: string; bundleId?: string }, signal?: AbortSignal) =>
    request<DictionaryPreview>("/api/dictionary/preview", { method: "POST", body, signal }),

  // -- settings -----------------------------------------------------------
  getSettings: (signal?: AbortSignal) => request<Settings>("/api/settings", { signal }),

  patchSettings: (patch: SettingsPatch) =>
    request<Settings>("/api/settings", { method: "PATCH", body: patch }),

  getPrompt: (signal?: AbortSignal) =>
    request<{ systemPrompt: string; isCustom: boolean }>("/api/settings/prompt", { signal }),

  resetPrompt: () => request<{ systemPrompt: string }>("/api/settings/reset-prompt", { method: "POST" }),

  // -- app profiles -------------------------------------------------------
  listAppProfiles: (signal?: AbortSignal) =>
    request<{ items: AppProfile[] }>("/api/app-profiles", { signal }),

  putAppProfile: (profile: AppProfile) =>
    request<AppProfile>("/api/app-profiles", { method: "PUT", body: profile }),

  deleteAppProfile: (bundleId: string) =>
    request<void>(`/api/app-profiles/${encodeURIComponent(bundleId)}`, {
      method: "DELETE",
      expectEmpty: true,
    }),

  // -- provider presets ---------------------------------------------------
  listProviderPresets: (signal?: AbortSignal) =>
    request<{ items: ProviderPreset[] }>("/api/provider-presets", { signal }),

  createProviderPreset: (input: ProviderPresetInput) =>
    request<ProviderPreset>("/api/provider-presets", { method: "POST", body: input }),

  deleteProviderPreset: (id: string) =>
    request<void>(`/api/provider-presets/${encodeURIComponent(id)}`, {
      method: "DELETE",
      expectEmpty: true,
    }),

  /**
   * Optional: when core exposes it, the effort/model lists come from the server
   * instead of the compiled-in `@lvf/shared` fallback. Resolves to null on 404.
   */
  providerCapabilities: async (signal?: AbortSignal): Promise<ProviderCapability[] | null> => {
    try {
      const result = await request<{ items: ProviderCapability[] }>("/api/providers", { signal });
      return Array.isArray(result?.items) ? result.items : null;
    } catch (error) {
      // Any failure here (absent endpoint, HTML fallback page) simply means "no
      // server-reported capabilities"; the caller falls back to @lvf/shared.
      if (error instanceof DOMException && error.name === "AbortError") throw error;
      return null;
    }
  },

  // -- diagnostics --------------------------------------------------------
  diagnostics: (signal?: AbortSignal) => request<DiagnosticsReport>("/api/diagnostics", { signal }),

  testProvider: (body: { provider: string; model: string; effort: string }, signal?: AbortSignal) =>
    request<TestProviderResult>("/api/diagnostics/test-provider", { method: "POST", body, signal }),

  testTranscription: (body: { path?: string } = {}, signal?: AbortSignal) =>
    request<TestTranscriptionResult>("/api/diagnostics/test-transcription", {
      method: "POST",
      body,
      signal,
    }),

  openDirectory: (target: "data" | "logs" | "audio") =>
    request<{ ok: boolean }>("/api/diagnostics/open", { method: "POST", body: { target } }),
};
