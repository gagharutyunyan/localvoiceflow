import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { SEED_DICTIONARY, canonicalKey } from "@lvf/shared";

export interface Migration {
  version: number;
  name: string;
  /** DDL executed first. */
  up: string;
  /** Data migration that SQL cannot express — runs inside the same transaction. */
  run?: (db: DatabaseSync) => void;
}

/**
 * Migrations are append-only. Never edit a shipped migration — add a new one, or an
 * existing database will silently diverge from a freshly created one.
 */
export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: "initial",
    up: `
      CREATE TABLE settings (
        key        TEXT PRIMARY KEY,
        value      TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE dictionary_terms (
        id         TEXT PRIMARY KEY,
        canonical  TEXT NOT NULL,
        aliases    TEXT NOT NULL DEFAULT '[]',
        category   TEXT,
        language   TEXT,
        notes      TEXT,
        enabled    INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX idx_dictionary_canonical
        ON dictionary_terms (canonical COLLATE NOCASE);
      CREATE INDEX idx_dictionary_enabled  ON dictionary_terms (enabled);
      CREATE INDEX idx_dictionary_category ON dictionary_terms (category);

      CREATE TABLE dictations (
        id                 TEXT PRIMARY KEY,
        created_at         TEXT NOT NULL,
        updated_at         TEXT NOT NULL,
        status             TEXT NOT NULL,
        app_name           TEXT,
        bundle_id          TEXT,
        recording_mode     TEXT NOT NULL,
        audio_duration_ms  INTEGER,
        raw_transcript     TEXT,
        final_text         TEXT,
        detected_language  TEXT,
        stt_provider       TEXT,
        stt_model          TEXT,
        llm_provider       TEXT,
        llm_model          TEXT,
        llm_effort         TEXT,
        stt_latency_ms     INTEGER,
        llm_latency_ms     INTEGER,
        total_latency_ms   INTEGER,
        audio_path         TEXT,
        error_code         TEXT,
        error_message      TEXT,
        warnings           TEXT NOT NULL DEFAULT '[]'
      );
      CREATE INDEX idx_dictations_created  ON dictations (created_at DESC);
      CREATE INDEX idx_dictations_status   ON dictations (status);
      CREATE INDEX idx_dictations_bundle   ON dictations (bundle_id);
      CREATE INDEX idx_dictations_provider ON dictations (llm_provider);
      CREATE INDEX idx_dictations_model    ON dictations (llm_model);

      CREATE TABLE app_profiles (
        bundle_id TEXT PRIMARY KEY,
        app_name  TEXT,
        profile   TEXT NOT NULL,
        builtin   INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE provider_presets (
        id       TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        model    TEXT NOT NULL,
        effort   TEXT NOT NULL,
        label    TEXT NOT NULL,
        builtin  INTEGER NOT NULL DEFAULT 0,
        last_ok_at TEXT
      );
      CREATE UNIQUE INDEX idx_presets_combo ON provider_presets (provider, model, effort);
    `,
  },
  {
    version: 2,
    name: "unicode-safe-dictionary-key",
    // SQLite's NOCASE collation folds ASCII only, so the v1 index let "Термин" and
    // "термин" coexist. Uniqueness now hangs off a key computed in JS.
    up: `
      DROP INDEX IF EXISTS idx_dictionary_canonical;
      ALTER TABLE dictionary_terms ADD COLUMN canonical_key TEXT NOT NULL DEFAULT '';
    `,
    run: (db) => {
      const rows = db.prepare("SELECT id, canonical FROM dictionary_terms").all() as {
        id: string;
        canonical: string;
      }[];
      const stmt = db.prepare("UPDATE dictionary_terms SET canonical_key = ? WHERE id = ?");
      for (const row of rows) stmt.run(canonicalKey(row.canonical), row.id);
      db.exec("CREATE UNIQUE INDEX idx_dictionary_key ON dictionary_terms (canonical_key)");
    },
  },
  {
    version: 3,
    name: "dictionary-priority-and-reseed",
    // Whisper's initial prompt fits ~20 terms out of a dictionary of several hundred, and
    // the rows arrive alphabetically — without a ranking column the hint is decided by
    // spelling, which is how "useEffect" ended up outside it.
    up: `
      ALTER TABLE dictionary_terms ADD COLUMN priority INTEGER NOT NULL DEFAULT 0;
    `,
    run: (db) => {
      const existingCount = (
        db.prepare("SELECT COUNT(*) AS c FROM dictionary_terms").get() as { c: number }
      ).c;
      // A brand-new database is filled by `seedIfEmpty` right after the migrations run;
      // seeding it here as well would defeat `Database.open({ seed: false })`.
      if (existingCount === 0) return;

      const find = db.prepare(
        "SELECT id, aliases, priority FROM dictionary_terms WHERE canonical_key = ?",
      );
      const insert = db.prepare(
        `INSERT INTO dictionary_terms
           (id, canonical, canonical_key, aliases, category, language, notes, enabled,
            priority, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
      );
      const update = db.prepare(
        "UPDATE dictionary_terms SET aliases = ?, priority = ?, updated_at = ? WHERE id = ?",
      );
      const ts = new Date().toISOString();

      for (const term of SEED_DICTIONARY) {
        const key = canonicalKey(term.canonical);
        const row = find.get(key) as
          | { id: string; aliases: string; priority: number }
          | undefined;
        if (!row) {
          insert.run(
            randomUUID(),
            term.canonical,
            key,
            JSON.stringify(term.aliases),
            term.category ?? null,
            term.language ?? null,
            term.notes ?? null,
            term.priority,
            ts,
            ts,
          );
          continue;
        }
        // The term already exists, possibly hand-edited: only add aliases and set the
        // ranking. Category, notes and the enabled flag stay as the user left them, and a
        // term they disabled on purpose stays disabled.
        let current: string[] = [];
        try {
          const parsed: unknown = JSON.parse(row.aliases);
          if (Array.isArray(parsed)) current = parsed.filter((a): a is string => typeof a === "string");
        } catch {
          current = [];
        }
        const merged = Array.from(new Set([...current, ...term.aliases]));
        update.run(JSON.stringify(merged), row.priority || term.priority, ts, row.id);
      }
    },
  },
];

export interface MigrationResult {
  applied: number[];
  currentVersion: number;
}

export function runMigrations(db: DatabaseSync): MigrationResult {
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    INTEGER PRIMARY KEY,
      name       TEXT NOT NULL,
      applied_at TEXT NOT NULL
    )
  `);

  const existing = new Set(
    (db.prepare("SELECT version FROM schema_migrations").all() as { version: number }[]).map(
      (row) => row.version,
    ),
  );

  const applied: number[] = [];
  for (const migration of MIGRATIONS) {
    if (existing.has(migration.version)) continue;
    // One transaction per migration: a failure leaves earlier migrations intact and
    // the failing one fully rolled back, so a retry starts from a consistent state.
    db.exec("BEGIN");
    try {
      db.exec(migration.up);
      migration.run?.(db);
      db.prepare(
        "INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)",
      ).run(migration.version, migration.name, new Date().toISOString());
      db.exec("COMMIT");
      applied.push(migration.version);
    } catch (error) {
      db.exec("ROLLBACK");
      throw new Error(
        `migration ${migration.version} (${migration.name}) failed: ${String(error)}`,
        { cause: error },
      );
    }
  }

  const current = db
    .prepare("SELECT COALESCE(MAX(version), 0) AS v FROM schema_migrations")
    .get() as { v: number };

  return { applied, currentVersion: current.v };
}
