import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { Database, mergeSettings } from "../dist/db/database.js";
import { MIGRATIONS, runMigrations } from "../dist/db/migrations.js";
import { SettingsSchema, defaultSettings } from "@lvf/shared";

let dir: string;

before(() => {
  dir = mkdtempSync(join(tmpdir(), "lvf-db-test-"));
});

after(() => {
  rmSync(dir, { recursive: true, force: true });
});

function freshDb(name: string): Database {
  return Database.open(join(dir, `${name}.sqlite`));
}

describe("migrations", () => {
  test("apply from empty and record their versions", () => {
    const raw = new DatabaseSync(join(dir, "migrate.sqlite"));
    const result = runMigrations(raw);
    assert.deepEqual(result.applied, MIGRATIONS.map((m) => m.version));
    assert.equal(result.currentVersion, MIGRATIONS.at(-1)!.version);
    raw.close();
  });

  test("are idempotent — a second run applies nothing", () => {
    const raw = new DatabaseSync(join(dir, "migrate.sqlite"));
    const result = runMigrations(raw);
    assert.deepEqual(result.applied, []);
    assert.equal(result.currentVersion, MIGRATIONS.at(-1)!.version);
    raw.close();
  });

  test("enable foreign keys and create every expected table", () => {
    const raw = new DatabaseSync(join(dir, "tables.sqlite"));
    runMigrations(raw);
    const rows = raw
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all() as { name: string }[];
    const names = new Set(rows.map((row) => row.name));
    for (const expected of [
      "dictations",
      "dictionary_terms",
      "settings",
      "app_profiles",
      "provider_presets",
      "schema_migrations",
    ]) {
      assert.ok(names.has(expected), `missing table ${expected}`);
    }
    const fk = raw.prepare("PRAGMA foreign_keys").get() as { foreign_keys: number };
    assert.equal(fk.foreign_keys, 1);
    raw.close();
  });

  test("history indexes exist, so filtering does not degrade to a scan", () => {
    const raw = new DatabaseSync(join(dir, "tables.sqlite"));
    const indexes = raw
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index'")
      .all() as { name: string }[];
    const names = new Set(indexes.map((row) => row.name));
    for (const expected of [
      "idx_dictations_created",
      "idx_dictations_status",
      "idx_dictations_bundle",
      "idx_dictations_provider",
      "idx_dictations_model",
    ]) {
      assert.ok(names.has(expected), `missing index ${expected}`);
    }
    raw.close();
  });
});

describe("dictionary reseed migration", () => {
  /** Rebuilds a database as it looked before the priority migration shipped. */
  function openAtVersion2(name: string): DatabaseSync {
    const raw = new DatabaseSync(join(dir, `${name}.sqlite`));
    raw.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version    INTEGER PRIMARY KEY,
        name       TEXT NOT NULL,
        applied_at TEXT NOT NULL
      )
    `);
    for (const migration of MIGRATIONS) {
      if (migration.version > 2) break;
      raw.exec(migration.up);
      migration.run?.(raw);
      raw
        .prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)")
        .run(migration.version, migration.name, new Date().toISOString());
    }
    return raw;
  }

  test("adds new seed terms to a dictionary the user already has", () => {
    const raw = openAtVersion2("reseed");
    const ts = new Date().toISOString();
    // One pre-existing term, hand-edited: a private alias and deliberately disabled.
    raw
      .prepare(
        `INSERT INTO dictionary_terms
           (id, canonical, canonical_key, aliases, category, language, notes, enabled,
            created_at, updated_at)
         VALUES ('own', 'React', 'react', '["мой алиас"]', 'Mine', 'mixed', NULL, 0, ?, ?)`,
      )
      .run(ts, ts);

    runMigrations(raw);
    raw.close();

    const db = Database.open(join(dir, "reseed.sqlite"));
    const terms = db.listTerms();
    const canonicals = new Set(terms.map((term) => term.canonical));
    assert.ok(canonicals.has("Claude Design"), "a new seed term must arrive in an old database");
    assert.ok(terms.length > 100, `expected the full seed, got ${terms.length}`);

    const react = terms.find((term) => term.canonical === "React")!;
    assert.equal(react.enabled, false, "a term the user disabled must stay disabled");
    assert.equal(react.category, "Mine", "hand-edited fields are not overwritten");
    assert.ok(react.aliases.includes("мой алиас"), "the user's own alias must survive");
    assert.ok(react.aliases.includes("реакт"), "seed aliases are merged in");
    assert.ok(react.priority > 0, "the migration fills in the new ranking");
    db.close();
  });

  test("leaves a fresh database to seedIfEmpty instead of seeding it twice", () => {
    const raw = openAtVersion2("reseed-empty");
    runMigrations(raw);
    const count = (
      raw.prepare("SELECT COUNT(*) AS c FROM dictionary_terms").get() as { c: number }
    ).c;
    raw.close();
    assert.equal(count, 0, "an empty dictionary is filled by seeding, not by the migration");
  });
});

describe("seeding", () => {
  test("populates the dictionary, app profiles and presets exactly once", () => {
    const db = freshDb("seed");
    const firstCount = db.listTerms().length;
    assert.ok(firstCount > 30, `expected a substantial seed dictionary, got ${firstCount}`);
    assert.ok(db.listAppProfiles().length > 10);
    assert.ok(db.listProviderPresets().length >= 6);

    db.seedIfEmpty();
    assert.equal(db.listTerms().length, firstCount, "seeding twice must not duplicate");
    db.close();
  });

  test("seeded terms include the goal's required entries", () => {
    const db = freshDb("seed2");
    const canonicals = new Set(db.listTerms().map((term) => term.canonical));
    for (const required of [
      "React",
      "TypeScript",
      "React Query",
      "useEffect",
      "useCallback",
      "Formik",
      "MUI",
      "Vite",
      "WebStorm",
      "Claude Code",
      "Codex",
      "PayAtTable",
      "YapYap",
    ]) {
      assert.ok(canonicals.has(required), `seed dictionary is missing "${required}"`);
    }
    db.close();
  });

  test("WebStorm and Terminal map to the developer profile out of the box", () => {
    const db = freshDb("profiles");
    const rules = db.listAppProfiles();
    assert.equal(rules.find((r) => r.bundleId === "com.jetbrains.WebStorm")?.profile, "developer");
    assert.equal(rules.find((r) => r.bundleId === "com.apple.Terminal")?.profile, "developer");
    assert.equal(rules.find((r) => r.bundleId === "ru.keepcoder.Telegram")?.profile, "smart");
    db.close();
  });
});

describe("settings", () => {
  test("defaults round-trip through the schema", () => {
    const db = freshDb("settings");
    const settings = db.getSettings();
    assert.equal(settings.correction.provider, "claude-cli");
    assert.equal(settings.correction.effort, "low", "low effort is the documented default");
    assert.equal(settings.stt.storeAudio, false, "audio storage is off by default");
    assert.equal(settings.correction.fallbackProviderEnabled, false, "fallback is off by default");
    assert.equal(settings.general.maxRecordingSeconds, 180);
    assert.equal(settings.general.insertRawTranscriptWhenLlmFails, true);
    db.close();
  });

  test("a patch merges deeply and leaves untouched sections alone", () => {
    const db = freshDb("settings2");
    const before = db.getSettings();
    const after = db.patchSettings({ correction: { model: "opus", effort: "high" } });
    assert.equal(after.correction.model, "opus");
    assert.equal(after.correction.effort, "high");
    assert.equal(after.correction.profile, before.correction.profile);
    assert.equal(after.stt.model, before.stt.model);
    db.close();
  });

  test("an out-of-range value is rejected rather than stored", () => {
    assert.throws(() =>
      mergeSettings(defaultSettings(), { general: { maxRecordingSeconds: 99_999 } }),
    );
    assert.throws(() => mergeSettings(defaultSettings(), { stt: { glossaryPromptLimit: -1 } }));
  });

  test("a malformed model id is rejected", () => {
    assert.throws(() => mergeSettings(defaultSettings(), { correction: { model: "a b; rm -rf /" } }));
    assert.throws(() => mergeSettings(defaultSettings(), { correction: { model: "" } }));
    assert.throws(() =>
      mergeSettings(defaultSettings(), { correction: { model: "x".repeat(200) } }),
    );
  });

  test("a plausible new model id is accepted without a code change", () => {
    const merged = mergeSettings(defaultSettings(), {
      correction: { model: "claude-some-future-model-9" },
    });
    assert.equal(merged.correction.model, "claude-some-future-model-9");
  });

  test("settings written by an older build are repaired on read", () => {
    const db = freshDb("settings3");
    // Simulate a stored blob that predates several fields.
    db.setMeta("settings", JSON.stringify({ correction: { model: "haiku" } }));
    const settings = db.getSettings();
    assert.equal(SettingsSchema.safeParse(settings).success, true);
    assert.equal(settings.general.maxRecordingSeconds, 180);
    db.close();
  });
});

describe("dictionary storage", () => {
  test("create, update, toggle and delete", () => {
    const db = freshDb("dict");
    const created = db.createTerm({ canonical: "Тестовый", aliases: ["тест один"], enabled: true });
    assert.equal(created.canonical, "Тестовый");

    const updated = db.updateTerm(created.id, { aliases: ["тест один", "тест два"] });
    assert.equal(updated?.aliases.length, 2);

    assert.equal(db.setTermsEnabled([created.id], false), 1);
    assert.equal(db.getTerm(created.id)?.enabled, false);
    assert.ok(!db.listEnabledTerms().some((term) => term.id === created.id));

    assert.equal(db.deleteTerm(created.id), true);
    assert.equal(db.getTerm(created.id), undefined);
    db.close();
  });

  test("canonical forms are unique case-insensitively", () => {
    const db = freshDb("dict2");
    db.createTerm({ canonical: "Уникальный", aliases: [], enabled: true });
    assert.ok(db.findTermByCanonical("уникальный"));
    assert.throws(() => db.createTerm({ canonical: "УНИКАЛЬНЫЙ", aliases: [], enabled: true }));
    db.close();
  });

  test("merge import unions aliases instead of discarding hand-added ones", () => {
    const db = freshDb("dict3");
    const created = db.createTerm({
      canonical: "MergeMe",
      aliases: ["добавлено вручную"],
      enabled: true,
    });
    const result = db.importTerms(
      [{ canonical: "MergeMe", aliases: ["из импорта"], enabled: true }],
      "merge",
    );
    assert.equal(result.updated, 1);
    assert.equal(result.created, 0);
    assert.deepEqual(db.getTerm(created.id)?.aliases.sort(), ["добавлено вручную", "из импорта"]);
    db.close();
  });

  test("import reports duplicates within the payload itself", () => {
    const db = freshDb("dict4");
    const result = db.importTerms(
      [
        { canonical: "DupTerm", aliases: [], enabled: true },
        { canonical: "dupterm", aliases: [], enabled: true },
      ],
      "merge",
    );
    assert.equal(result.created, 1);
    assert.equal(result.skipped, 1);
    assert.ok(result.duplicates.length >= 1);
    db.close();
  });

  test("replace import clears the previous contents in one transaction", () => {
    const db = freshDb("dict5");
    const result = db.importTerms([{ canonical: "OnlyOne", aliases: [], enabled: true }], "replace");
    assert.equal(result.created, 1);
    assert.equal(db.listTerms().length, 1);
    db.close();
  });
});

describe("history filters", () => {
  function seedHistory(db: Database): void {
    const rows = [
      { id: "d1", bundleId: "com.apple.Terminal", provider: "claude-cli", model: "haiku", status: "completed" },
      { id: "d2", bundleId: "com.jetbrains.WebStorm", provider: "claude-cli", model: "opus", status: "completed" },
      { id: "d3", bundleId: "com.apple.Terminal", provider: "openai-codex-cli", model: "gpt-5.6-luna", status: "failed" },
    ] as const;

    for (const row of rows) {
      db.createDictation({ id: row.id, status: "correcting", recordingMode: "push-to-talk", bundleId: row.bundleId });
      db.updateDictation(row.id, {
        status: row.status as never,
        llmProvider: row.provider,
        llmModel: row.model,
        rawTranscript: `сырой текст ${row.id}`,
        finalText: `итоговый текст ${row.id}`,
        totalLatencyMs: 2000,
      });
    }
  }

  test("filters by status, app, provider and model", () => {
    const db = freshDb("history");
    seedHistory(db);

    assert.equal(db.listDictations({ status: "failed", limit: 50, offset: 0 }).total, 1);
    assert.equal(db.listDictations({ bundleId: "com.apple.Terminal", limit: 50, offset: 0 }).total, 2);
    assert.equal(db.listDictations({ llmProvider: "claude-cli", limit: 50, offset: 0 }).total, 2);
    assert.equal(db.listDictations({ llmModel: "opus", limit: 50, offset: 0 }).total, 1);
    db.close();
  });

  test("free-text search covers both raw and final text", () => {
    const db = freshDb("history2");
    seedHistory(db);
    assert.equal(db.listDictations({ q: "сырой текст d2", limit: 50, offset: 0 }).total, 1);
    assert.equal(db.listDictations({ q: "итоговый текст d3", limit: 50, offset: 0 }).total, 1);
    assert.equal(db.listDictations({ q: "не существует", limit: 50, offset: 0 }).total, 0);
    db.close();
  });

  test("combining filters narrows rather than widens", () => {
    const db = freshDb("history3");
    seedHistory(db);
    const result = db.listDictations({
      bundleId: "com.apple.Terminal",
      llmProvider: "claude-cli",
      limit: 50,
      offset: 0,
    });
    assert.equal(result.total, 1);
    assert.equal(result.items[0]?.id, "d1");
    db.close();
  });

  test("date bounds are inclusive-from and exclusive-to", () => {
    const db = freshDb("history4");
    seedHistory(db);
    const all = db.listDictations({ limit: 50, offset: 0 });
    const created = all.items[0]!.createdAt;

    assert.equal(db.listDictations({ from: created, limit: 50, offset: 0 }).total >= 1, true);
    assert.equal(db.listDictations({ to: "1971-01-01T00:00:00.000Z", limit: 50, offset: 0 }).total, 0);
    assert.equal(db.listDictations({ from: "2999-01-01T00:00:00.000Z", limit: 50, offset: 0 }).total, 0);
    db.close();
  });

  test("paging reports the unpaged total", () => {
    const db = freshDb("history5");
    seedHistory(db);
    const page = db.listDictations({ limit: 2, offset: 0 });
    assert.equal(page.items.length, 2);
    assert.equal(page.total, 3);
    db.close();
  });

  test("bulk and full deletion", () => {
    const db = freshDb("history6");
    seedHistory(db);
    assert.equal(db.deleteDictations(["d1", "d2"]), 2);
    assert.equal(db.listDictations({ limit: 50, offset: 0 }).total, 1);
    assert.equal(db.clearDictations(), 1);
    assert.equal(db.listDictations({ limit: 50, offset: 0 }).total, 0);
    db.close();
  });
});

describe("provider presets", () => {
  test("a custom model is saved and reappears", () => {
    const db = freshDb("presets");
    const preset = db.upsertProviderPreset({
      provider: "claude-cli",
      model: "claude-future-9",
      effort: "low",
      label: "My custom",
    });
    assert.ok(db.listProviderPresets().some((p) => p.id === preset.id));

    db.markPresetOk("claude-cli", "claude-future-9", "low");
    assert.ok(db.listProviderPresets().find((p) => p.id === preset.id)?.lastOkAt);

    assert.equal(db.deleteProviderPreset(preset.id), true);
    db.close();
  });

  test("built-in presets cannot be deleted", () => {
    const db = freshDb("presets2");
    const builtin = db.listProviderPresets().find((p) => p.builtin)!;
    assert.equal(db.deleteProviderPreset(builtin.id), false);
    db.close();
  });
});
