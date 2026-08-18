import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import {
  BUILTIN_APP_PROFILES,
  SEED_DICTIONARY,
  SettingsSchema,
  canonicalKey,
  defaultSettings,
  type AppProfile,
  type DictationRecord,
  type DictionaryTerm,
  type DictionaryTermInput,
  type DictionaryTermPatch,
  type HistoryQuery,
  type Settings,
  type SettingsPatch,
} from "@lvf/shared";
import { runMigrations } from "./migrations.js";

export interface ProviderPreset {
  id: string;
  provider: string;
  model: string;
  effort: string;
  label: string;
  builtin: boolean;
  lastOkAt?: string;
}

const BUILTIN_PRESETS: readonly Omit<ProviderPreset, "id" | "builtin">[] = [
  { provider: "claude-cli", model: "haiku", effort: "low", label: "Claude Haiku · low (fastest)" },
  { provider: "claude-cli", model: "sonnet", effort: "low", label: "Claude Sonnet · low" },
  { provider: "claude-cli", model: "opus", effort: "low", label: "Claude Opus · low (quality)" },
  { provider: "openai-codex-cli", model: "gpt-5.6-luna", effort: "none", label: "GPT-5.6 Luna · none" },
  { provider: "openai-codex-cli", model: "gpt-5.6-terra", effort: "low", label: "GPT-5.6 Terra · low" },
  { provider: "openai-codex-cli", model: "gpt-5.6-sol", effort: "low", label: "GPT-5.6 Sol · low (quality)" },
];

function nowIso(): string {
  return new Date().toISOString();
}

function toBool(value: unknown): boolean {
  return value === 1 || value === true || value === "1";
}

function parseJsonArray(value: unknown): string[] {
  if (typeof value !== "string" || value.length === 0) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

interface DictationRow {
  id: string;
  created_at: string;
  updated_at: string;
  status: string;
  app_name: string | null;
  bundle_id: string | null;
  recording_mode: string;
  audio_duration_ms: number | null;
  raw_transcript: string | null;
  final_text: string | null;
  detected_language: string | null;
  stt_provider: string | null;
  stt_model: string | null;
  llm_provider: string | null;
  llm_model: string | null;
  llm_effort: string | null;
  stt_latency_ms: number | null;
  llm_latency_ms: number | null;
  total_latency_ms: number | null;
  audio_path: string | null;
  error_code: string | null;
  error_message: string | null;
  warnings: string;
}

function rowToDictation(row: DictationRow): DictationRecord {
  const record: DictationRecord = {
    id: row.id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    status: row.status as DictationRecord["status"],
    recordingMode: row.recording_mode as DictationRecord["recordingMode"],
    warnings: parseJsonArray(row.warnings),
  };
  if (row.app_name !== null) record.appName = row.app_name;
  if (row.bundle_id !== null) record.bundleId = row.bundle_id;
  if (row.audio_duration_ms !== null) record.audioDurationMs = row.audio_duration_ms;
  if (row.raw_transcript !== null) record.rawTranscript = row.raw_transcript;
  if (row.final_text !== null) record.finalText = row.final_text;
  if (row.detected_language !== null) record.detectedLanguage = row.detected_language;
  if (row.stt_provider !== null) record.sttProvider = row.stt_provider;
  if (row.stt_model !== null) record.sttModel = row.stt_model;
  if (row.llm_provider !== null) record.llmProvider = row.llm_provider;
  if (row.llm_model !== null) record.llmModel = row.llm_model;
  if (row.llm_effort !== null) record.llmEffort = row.llm_effort;
  if (row.stt_latency_ms !== null) record.sttLatencyMs = row.stt_latency_ms;
  if (row.llm_latency_ms !== null) record.llmLatencyMs = row.llm_latency_ms;
  if (row.total_latency_ms !== null) record.totalLatencyMs = row.total_latency_ms;
  if (row.audio_path !== null) record.audioPath = row.audio_path;
  if (row.error_code !== null) record.errorCode = row.error_code;
  if (row.error_message !== null) record.errorMessage = row.error_message;
  return record;
}

/** Deep-merges a settings patch onto the stored settings and revalidates the whole object. */
export function mergeSettings(current: Settings, patch: SettingsPatch): Settings {
  return SettingsSchema.parse({
    general: { ...current.general, ...(patch.general ?? {}) },
    stt: { ...current.stt, ...(patch.stt ?? {}) },
    correction: { ...current.correction, ...(patch.correction ?? {}) },
    privacy: { ...current.privacy, ...(patch.privacy ?? {}) },
  });
}

export class Database {
  readonly #db: DatabaseSync;

  private constructor(db: DatabaseSync) {
    this.#db = db;
  }

  static open(file: string, options: { seed?: boolean } = {}): Database {
    const db = new DatabaseSync(file);
    runMigrations(db);
    const instance = new Database(db);
    if (options.seed !== false) instance.seedIfEmpty();
    return instance;
  }

  get raw(): DatabaseSync {
    return this.#db;
  }

  close(): void {
    this.#db.close();
  }

  /** True when the database file accepts writes; surfaced by doctor. */
  isWritable(): boolean {
    try {
      this.#db.exec("CREATE TABLE IF NOT EXISTS _writecheck (x INTEGER)");
      this.#db.exec("DROP TABLE IF EXISTS _writecheck");
      return true;
    } catch {
      return false;
    }
  }

  // -------------------------------------------------------------------------
  // Seeding
  // -------------------------------------------------------------------------

  seedIfEmpty(): void {
    const dictCount = this.#db.prepare("SELECT COUNT(*) AS c FROM dictionary_terms").get() as {
      c: number;
    };
    if (dictCount.c === 0) {
      this.#db.exec("BEGIN");
      try {
        for (const term of SEED_DICTIONARY) this.#insertTerm(term);
        this.#db.exec("COMMIT");
      } catch (error) {
        this.#db.exec("ROLLBACK");
        throw error;
      }
    }

    const profileCount = this.#db.prepare("SELECT COUNT(*) AS c FROM app_profiles").get() as {
      c: number;
    };
    if (profileCount.c === 0) {
      const stmt = this.#db.prepare(
        "INSERT INTO app_profiles (bundle_id, app_name, profile, builtin) VALUES (?, ?, ?, 1)",
      );
      this.#db.exec("BEGIN");
      try {
        for (const rule of BUILTIN_APP_PROFILES) {
          stmt.run(rule.bundleId, rule.appName ?? null, rule.profile);
        }
        this.#db.exec("COMMIT");
      } catch (error) {
        this.#db.exec("ROLLBACK");
        throw error;
      }
    }

    const presetCount = this.#db.prepare("SELECT COUNT(*) AS c FROM provider_presets").get() as {
      c: number;
    };
    if (presetCount.c === 0) {
      const stmt = this.#db.prepare(
        "INSERT INTO provider_presets (id, provider, model, effort, label, builtin) VALUES (?, ?, ?, ?, ?, 1)",
      );
      this.#db.exec("BEGIN");
      try {
        for (const preset of BUILTIN_PRESETS) {
          stmt.run(randomUUID(), preset.provider, preset.model, preset.effort, preset.label);
        }
        this.#db.exec("COMMIT");
      } catch (error) {
        this.#db.exec("ROLLBACK");
        throw error;
      }
    }
  }

  // -------------------------------------------------------------------------
  // Settings
  // -------------------------------------------------------------------------

  getSettings(): Settings {
    const row = this.#db.prepare("SELECT value FROM settings WHERE key = 'settings'").get() as
      | { value: string }
      | undefined;
    if (!row) return defaultSettings();
    try {
      // Parsing through the schema also repairs a settings blob written by an older
      // build that lacks fields the current one expects.
      return SettingsSchema.parse(JSON.parse(row.value));
    } catch {
      return defaultSettings();
    }
  }

  setSettings(settings: Settings): Settings {
    const validated = SettingsSchema.parse(settings);
    this.#db
      .prepare(
        `INSERT INTO settings (key, value, updated_at) VALUES ('settings', ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(JSON.stringify(validated), nowIso());
    return validated;
  }

  patchSettings(patch: SettingsPatch): Settings {
    return this.setSettings(mergeSettings(this.getSettings(), patch));
  }

  getMeta(key: string): string | undefined {
    const row = this.#db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as
      | { value: string }
      | undefined;
    return row?.value;
  }

  setMeta(key: string, value: string): void {
    this.#db
      .prepare(
        `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(key, value, nowIso());
  }

  deleteMeta(key: string): void {
    this.#db.prepare("DELETE FROM settings WHERE key = ?").run(key);
  }

  // -------------------------------------------------------------------------
  // Dictionary
  // -------------------------------------------------------------------------

  #insertTerm(input: DictionaryTermInput): DictionaryTerm {
    const id = randomUUID();
    const ts = nowIso();
    this.#db
      .prepare(
        `INSERT INTO dictionary_terms
           (id, canonical, canonical_key, aliases, category, language, notes, enabled,
            priority, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.canonical,
        canonicalKey(input.canonical),
        JSON.stringify(input.aliases ?? []),
        input.category ?? null,
        input.language ?? null,
        input.notes ?? null,
        input.enabled === false ? 0 : 1,
        input.priority ?? 0,
        ts,
        ts,
      );
    return this.getTerm(id)!;
  }

  listTerms(): DictionaryTerm[] {
    const rows = this.#db
      .prepare("SELECT * FROM dictionary_terms ORDER BY canonical COLLATE NOCASE")
      .all() as Record<string, unknown>[];
    return rows.map((row) => this.#rowToTerm(row));
  }

  listEnabledTerms(): DictionaryTerm[] {
    return this.listTerms().filter((term) => term.enabled);
  }

  getTerm(id: string): DictionaryTerm | undefined {
    const row = this.#db.prepare("SELECT * FROM dictionary_terms WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? this.#rowToTerm(row) : undefined;
  }

  findTermByCanonical(canonical: string): DictionaryTerm | undefined {
    const row = this.#db
      .prepare("SELECT * FROM dictionary_terms WHERE canonical_key = ?")
      .get(canonicalKey(canonical)) as Record<string, unknown> | undefined;
    return row ? this.#rowToTerm(row) : undefined;
  }

  #rowToTerm(row: Record<string, unknown>): DictionaryTerm {
    const term: DictionaryTerm = {
      id: String(row.id),
      canonical: String(row.canonical),
      aliases: parseJsonArray(row.aliases),
      enabled: toBool(row.enabled),
      priority: Number(row.priority ?? 0),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
    if (row.category !== null && row.category !== undefined) term.category = String(row.category);
    if (row.language !== null && row.language !== undefined)
      term.language = String(row.language) as DictionaryTerm["language"];
    if (row.notes !== null && row.notes !== undefined) term.notes = String(row.notes);
    return term;
  }

  createTerm(input: DictionaryTermInput): DictionaryTerm {
    return this.#insertTerm(input);
  }

  updateTerm(id: string, patch: DictionaryTermPatch): DictionaryTerm | undefined {
    const current = this.getTerm(id);
    if (!current) return undefined;

    const next = {
      canonical: patch.canonical ?? current.canonical,
      aliases: patch.aliases ?? current.aliases,
      category: patch.category === undefined ? (current.category ?? null) : patch.category,
      language: patch.language === undefined ? (current.language ?? null) : patch.language,
      notes: patch.notes === undefined ? (current.notes ?? null) : patch.notes,
      enabled: patch.enabled ?? current.enabled,
      priority: patch.priority ?? current.priority,
    };

    this.#db
      .prepare(
        `UPDATE dictionary_terms
            SET canonical = ?, canonical_key = ?, aliases = ?, category = ?, language = ?,
                notes = ?, enabled = ?, priority = ?, updated_at = ?
          WHERE id = ?`,
      )
      .run(
        next.canonical,
        canonicalKey(next.canonical),
        JSON.stringify(next.aliases),
        next.category,
        next.language,
        next.notes,
        next.enabled ? 1 : 0,
        next.priority,
        nowIso(),
        id,
      );
    return this.getTerm(id);
  }

  deleteTerm(id: string): boolean {
    const result = this.#db.prepare("DELETE FROM dictionary_terms WHERE id = ?").run(id);
    return Number(result.changes) > 0;
  }

  setTermsEnabled(ids: readonly string[], enabled: boolean): number {
    if (ids.length === 0) return 0;
    const stmt = this.#db.prepare(
      "UPDATE dictionary_terms SET enabled = ?, updated_at = ? WHERE id = ?",
    );
    const ts = nowIso();
    let updated = 0;
    this.#db.exec("BEGIN");
    try {
      for (const id of ids) {
        updated += Number(stmt.run(enabled ? 1 : 0, ts, id).changes);
      }
      this.#db.exec("COMMIT");
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
    return updated;
  }

  importTerms(
    terms: readonly DictionaryTermInput[],
    mode: "merge" | "replace",
  ): { created: number; updated: number; skipped: number; duplicates: string[] } {
    let created = 0;
    let updated = 0;
    let skipped = 0;
    const duplicates: string[] = [];
    const seen = new Set<string>();

    this.#db.exec("BEGIN");
    try {
      if (mode === "replace") this.#db.exec("DELETE FROM dictionary_terms");

      for (const term of terms) {
        const key = canonicalKey(term.canonical);
        if (seen.has(key)) {
          duplicates.push(term.canonical);
          skipped += 1;
          continue;
        }
        seen.add(key);

        const existing = mode === "replace" ? undefined : this.findTermByCanonical(term.canonical);
        if (existing) {
          duplicates.push(term.canonical);
          // Merging unions the alias sets rather than replacing, so importing a partial
          // list never silently drops aliases the user added by hand.
          const mergedAliases = Array.from(new Set([...existing.aliases, ...(term.aliases ?? [])]));
          this.updateTerm(existing.id, {
            aliases: mergedAliases,
            category: term.category ?? existing.category ?? null,
            language: term.language ?? existing.language ?? null,
            notes: term.notes ?? existing.notes ?? null,
            enabled: term.enabled,
            // A priority of 0 means "unset" rather than "lowest", so an import that omits
            // it must not demote a term the user (or the seed) had ranked.
            priority: term.priority || existing.priority,
          });
          updated += 1;
        } else {
          this.#insertTerm(term);
          created += 1;
        }
      }
      this.#db.exec("COMMIT");
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }

    return { created, updated, skipped, duplicates };
  }

  // -------------------------------------------------------------------------
  // Dictations
  // -------------------------------------------------------------------------

  createDictation(record: Partial<DictationRecord> & Pick<DictationRecord, "id" | "status" | "recordingMode">): DictationRecord {
    const ts = nowIso();
    this.#db
      .prepare(
        `INSERT INTO dictations (id, created_at, updated_at, status, app_name, bundle_id,
                                 recording_mode, audio_duration_ms, warnings)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.createdAt ?? ts,
        ts,
        record.status,
        record.appName ?? null,
        record.bundleId ?? null,
        record.recordingMode,
        record.audioDurationMs ?? null,
        JSON.stringify(record.warnings ?? []),
      );
    return this.getDictation(record.id)!;
  }

  updateDictation(id: string, patch: Partial<DictationRecord>): DictationRecord | undefined {
    const columns: Record<keyof DictationRecord, string | undefined> = {
      id: undefined,
      createdAt: undefined,
      updatedAt: undefined,
      status: "status",
      appName: "app_name",
      bundleId: "bundle_id",
      recordingMode: "recording_mode",
      audioDurationMs: "audio_duration_ms",
      rawTranscript: "raw_transcript",
      finalText: "final_text",
      detectedLanguage: "detected_language",
      sttProvider: "stt_provider",
      sttModel: "stt_model",
      llmProvider: "llm_provider",
      llmModel: "llm_model",
      llmEffort: "llm_effort",
      sttLatencyMs: "stt_latency_ms",
      llmLatencyMs: "llm_latency_ms",
      totalLatencyMs: "total_latency_ms",
      audioPath: "audio_path",
      errorCode: "error_code",
      errorMessage: "error_message",
      warnings: "warnings",
    };

    const sets: string[] = [];
    const values: (string | number | null)[] = [];

    for (const [key, column] of Object.entries(columns)) {
      if (!column) continue;
      if (!(key in patch)) continue;
      const value = patch[key as keyof DictationRecord];
      sets.push(`${column} = ?`);
      if (key === "warnings") values.push(JSON.stringify(value ?? []));
      else if (value === undefined) values.push(null);
      else if (typeof value === "number" || typeof value === "string") values.push(value);
      else values.push(String(value));
    }

    if (sets.length === 0) return this.getDictation(id);

    sets.push("updated_at = ?");
    values.push(nowIso(), id);

    this.#db.prepare(`UPDATE dictations SET ${sets.join(", ")} WHERE id = ?`).run(...values);
    return this.getDictation(id);
  }

  getDictation(id: string): DictationRecord | undefined {
    const row = this.#db.prepare("SELECT * FROM dictations WHERE id = ?").get(id) as
      | DictationRow
      | undefined;
    return row ? rowToDictation(row) : undefined;
  }

  listDictations(query: HistoryQuery): { items: DictationRecord[]; total: number } {
    const where: string[] = [];
    const params: (string | number)[] = [];

    if (query.q) {
      where.push("(raw_transcript LIKE ? OR final_text LIKE ?)");
      const like = `%${query.q}%`;
      params.push(like, like);
    }
    if (query.status) {
      where.push("status = ?");
      params.push(query.status);
    }
    if (query.bundleId) {
      where.push("bundle_id = ?");
      params.push(query.bundleId);
    }
    if (query.llmProvider) {
      where.push("llm_provider = ?");
      params.push(query.llmProvider);
    }
    if (query.llmModel) {
      where.push("llm_model = ?");
      params.push(query.llmModel);
    }
    if (query.from) {
      where.push("created_at >= ?");
      params.push(query.from);
    }
    if (query.to) {
      where.push("created_at < ?");
      params.push(query.to);
    }

    const clause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";

    const total = this.#db
      .prepare(`SELECT COUNT(*) AS c FROM dictations ${clause}`)
      .get(...params) as { c: number };

    const rows = this.#db
      .prepare(
        `SELECT * FROM dictations ${clause} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      )
      .all(...params, query.limit, query.offset) as unknown as DictationRow[];

    return { items: rows.map(rowToDictation), total: total.c };
  }

  lastDictation(): DictationRecord | undefined {
    const row = this.#db
      .prepare("SELECT * FROM dictations ORDER BY created_at DESC LIMIT 1")
      .get() as DictationRow | undefined;
    return row ? rowToDictation(row) : undefined;
  }

  deleteDictation(id: string): boolean {
    const result = this.#db.prepare("DELETE FROM dictations WHERE id = ?").run(id);
    return Number(result.changes) > 0;
  }

  deleteDictations(ids: readonly string[]): number {
    if (ids.length === 0) return 0;
    const stmt = this.#db.prepare("DELETE FROM dictations WHERE id = ?");
    let deleted = 0;
    this.#db.exec("BEGIN");
    try {
      for (const id of ids) deleted += Number(stmt.run(id).changes);
      this.#db.exec("COMMIT");
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
    return deleted;
  }

  clearDictations(): number {
    const before = this.#db.prepare("SELECT COUNT(*) AS c FROM dictations").get() as { c: number };
    this.#db.exec("DELETE FROM dictations");
    return before.c;
  }

  allAudioPaths(): string[] {
    const rows = this.#db
      .prepare("SELECT audio_path FROM dictations WHERE audio_path IS NOT NULL")
      .all() as { audio_path: string }[];
    return rows.map((row) => row.audio_path);
  }

  // -------------------------------------------------------------------------
  // App profiles
  // -------------------------------------------------------------------------

  listAppProfiles(): AppProfile[] {
    const rows = this.#db
      .prepare("SELECT * FROM app_profiles ORDER BY app_name, bundle_id")
      .all() as Record<string, unknown>[];
    return rows.map((row) => {
      const profile: AppProfile = {
        bundleId: String(row.bundle_id),
        profile: String(row.profile) as AppProfile["profile"],
        builtin: toBool(row.builtin),
      };
      if (row.app_name !== null && row.app_name !== undefined) profile.appName = String(row.app_name);
      return profile;
    });
  }

  upsertAppProfile(profile: AppProfile): AppProfile {
    this.#db
      .prepare(
        `INSERT INTO app_profiles (bundle_id, app_name, profile, builtin) VALUES (?, ?, ?, ?)
         ON CONFLICT(bundle_id) DO UPDATE SET app_name = excluded.app_name, profile = excluded.profile`,
      )
      .run(profile.bundleId, profile.appName ?? null, profile.profile, profile.builtin ? 1 : 0);
    return profile;
  }

  deleteAppProfile(bundleId: string): boolean {
    const result = this.#db.prepare("DELETE FROM app_profiles WHERE bundle_id = ?").run(bundleId);
    return Number(result.changes) > 0;
  }

  // -------------------------------------------------------------------------
  // Provider presets
  // -------------------------------------------------------------------------

  listProviderPresets(): ProviderPreset[] {
    const rows = this.#db
      .prepare("SELECT * FROM provider_presets ORDER BY builtin DESC, label")
      .all() as Record<string, unknown>[];
    return rows.map((row) => {
      const preset: ProviderPreset = {
        id: String(row.id),
        provider: String(row.provider),
        model: String(row.model),
        effort: String(row.effort),
        label: String(row.label),
        builtin: toBool(row.builtin),
      };
      if (row.last_ok_at !== null && row.last_ok_at !== undefined) {
        preset.lastOkAt = String(row.last_ok_at);
      }
      return preset;
    });
  }

  upsertProviderPreset(preset: Omit<ProviderPreset, "id" | "builtin"> & { id?: string }): ProviderPreset {
    const existing = this.#db
      .prepare("SELECT id FROM provider_presets WHERE provider = ? AND model = ? AND effort = ?")
      .get(preset.provider, preset.model, preset.effort) as { id: string } | undefined;

    if (existing) {
      this.#db
        .prepare("UPDATE provider_presets SET label = ? WHERE id = ?")
        .run(preset.label, existing.id);
      return this.listProviderPresets().find((p) => p.id === existing.id)!;
    }

    const id = preset.id ?? randomUUID();
    this.#db
      .prepare(
        "INSERT INTO provider_presets (id, provider, model, effort, label, builtin) VALUES (?, ?, ?, ?, ?, 0)",
      )
      .run(id, preset.provider, preset.model, preset.effort, preset.label);
    return this.listProviderPresets().find((p) => p.id === id)!;
  }

  markPresetOk(provider: string, model: string, effort: string): void {
    this.#db
      .prepare(
        "UPDATE provider_presets SET last_ok_at = ? WHERE provider = ? AND model = ? AND effort = ?",
      )
      .run(nowIso(), provider, model, effort);
  }

  deleteProviderPreset(id: string): boolean {
    const result = this.#db
      .prepare("DELETE FROM provider_presets WHERE id = ? AND builtin = 0")
      .run(id);
    return Number(result.changes) > 0;
  }
}
