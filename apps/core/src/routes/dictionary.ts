import { z } from "zod";
import {
  DictionaryImportSchema,
  DictionaryTermInputSchema,
  DictionaryTermPatchSchema,
  applyDeterministicReplacements,
  buildSttInitialPrompt,
  previewCorrectionPayload,
  resolveProfile,
  selectGlossary,
  type DictionaryTerm,
} from "@lvf/shared";
import type { FastifyInstance } from "fastify";
import type { ServerContext } from "../context.js";

const BulkSchema = z.object({
  ids: z.array(z.string().max(80)).max(5000),
  enabled: z.boolean(),
});

const PreviewSchema = z.object({
  rawTranscript: z.string().max(50_000),
  bundleId: z.string().max(200).optional(),
});

const CsvImportSchema = z.object({
  csv: z.string().max(2_000_000),
  mode: z.enum(["merge", "replace"]).default("merge"),
});

/**
 * Minimal CSV reader supporting quoted fields and embedded newlines.
 * Expected columns: canonical, aliases (pipe- or semicolon-separated), category,
 * language, notes, enabled.
 */
export function parseDictionaryCsv(text: string): z.infer<typeof DictionaryTermInputSchema>[] {
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let inQuotes = false;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (ch !== "\r") {
      field += ch;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  if (rows.length === 0) return [];

  const header = rows[0]!.map((cell) => cell.trim().toLowerCase());
  const indexOf = (name: string): number => header.indexOf(name);
  const canonicalIdx = indexOf("canonical");
  if (canonicalIdx === -1) {
    throw new Error('CSV must have a "canonical" column');
  }
  const aliasesIdx = indexOf("aliases");
  const categoryIdx = indexOf("category");
  const languageIdx = indexOf("language");
  const notesIdx = indexOf("notes");
  const enabledIdx = indexOf("enabled");

  const out: z.infer<typeof DictionaryTermInputSchema>[] = [];
  for (const cells of rows.slice(1)) {
    const canonical = (cells[canonicalIdx] ?? "").trim();
    if (canonical.length === 0) continue;

    const aliasesRaw = aliasesIdx >= 0 ? (cells[aliasesIdx] ?? "") : "";
    const aliases = aliasesRaw
      .split(/[|;]/)
      .map((alias) => alias.trim())
      .filter((alias) => alias.length > 0);

    const enabledRaw = enabledIdx >= 0 ? (cells[enabledIdx] ?? "").trim().toLowerCase() : "";
    const language = languageIdx >= 0 ? (cells[languageIdx] ?? "").trim() : "";

    out.push(
      DictionaryTermInputSchema.parse({
        canonical,
        aliases,
        category: categoryIdx >= 0 ? (cells[categoryIdx] ?? "").trim() || null : null,
        language: language === "ru" || language === "en" || language === "mixed" ? language : null,
        notes: notesIdx >= 0 ? (cells[notesIdx] ?? "").trim() || null : null,
        enabled: enabledRaw === "" ? true : !["0", "false", "no", "нет"].includes(enabledRaw),
      }),
    );
  }
  return out;
}

export function dictionaryToCsv(terms: readonly DictionaryTerm[]): string {
  const escape = (value: unknown): string => {
    const text = value === undefined || value === null ? "" : String(value);
    return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  const lines = ["canonical,aliases,category,language,notes,enabled"];
  for (const term of terms) {
    lines.push(
      [
        escape(term.canonical),
        escape(term.aliases.join("|")),
        escape(term.category),
        escape(term.language),
        escape(term.notes),
        term.enabled ? "true" : "false",
      ].join(","),
    );
  }
  return lines.join("\n");
}

export function registerDictionaryRoutes(app: FastifyInstance, ctx: ServerContext): void {
  app.get("/api/dictionary", async (_request, reply) => {
    return reply.send({ items: ctx.db.listTerms() });
  });

  app.post("/api/dictionary", async (request, reply) => {
    const parsed = DictionaryTermInputSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: { code: "bad_request", message: parsed.error.message } });
    }
    const existing = ctx.db.findTermByCanonical(parsed.data.canonical);
    if (existing) {
      return reply.code(409).send({
        error: { code: "duplicate", message: `"${parsed.data.canonical}" already exists` },
        existing,
      });
    }
    return reply.code(201).send(ctx.db.createTerm(parsed.data));
  });

  app.patch<{ Params: { id: string } }>("/api/dictionary/:id", async (request, reply) => {
    const parsed = DictionaryTermPatchSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: { code: "bad_request", message: parsed.error.message } });
    }
    if (parsed.data.canonical) {
      const clash = ctx.db.findTermByCanonical(parsed.data.canonical);
      if (clash && clash.id !== request.params.id) {
        return reply.code(409).send({
          error: { code: "duplicate", message: `"${parsed.data.canonical}" already exists` },
        });
      }
    }
    const updated = ctx.db.updateTerm(request.params.id, parsed.data);
    if (!updated) {
      return reply.code(404).send({ error: { code: "not_found", message: "no such term" } });
    }
    return reply.send(updated);
  });

  app.delete<{ Params: { id: string } }>("/api/dictionary/:id", async (request, reply) => {
    const deleted = ctx.db.deleteTerm(request.params.id);
    if (!deleted) {
      return reply.code(404).send({ error: { code: "not_found", message: "no such term" } });
    }
    return reply.send({ deleted: true });
  });

  app.post("/api/dictionary/bulk", async (request, reply) => {
    const parsed = BulkSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: { code: "bad_request", message: parsed.error.message } });
    }
    return reply.send({ updated: ctx.db.setTermsEnabled(parsed.data.ids, parsed.data.enabled) });
  });

  app.post("/api/dictionary/import", async (request, reply) => {
    const body = request.body as Record<string, unknown> | undefined;

    if (body && typeof body.csv === "string") {
      const parsed = CsvImportSchema.safeParse(body);
      if (!parsed.success) {
        return reply.code(400).send({ error: { code: "bad_request", message: parsed.error.message } });
      }
      try {
        const terms = parseDictionaryCsv(parsed.data.csv);
        return reply.send(ctx.db.importTerms(terms, parsed.data.mode));
      } catch (error) {
        return reply
          .code(400)
          .send({ error: { code: "bad_request", message: (error as Error).message } });
      }
    }

    const parsed = DictionaryImportSchema.safeParse(body);
    if (!parsed.success) {
      return reply.code(400).send({ error: { code: "bad_request", message: parsed.error.message } });
    }
    return reply.send(ctx.db.importTerms(parsed.data.terms, parsed.data.mode));
  });

  app.get("/api/dictionary/export", async (request, reply) => {
    const format = (request.query as { format?: string }).format ?? "json";
    const terms = ctx.db.listTerms();
    if (format === "csv") {
      return reply
        .header("content-type", "text/csv; charset=utf-8")
        .header("content-disposition", 'attachment; filename="local-voice-flow-dictionary.csv"')
        .send(dictionaryToCsv(terms));
    }
    return reply
      .header("content-type", "application/json; charset=utf-8")
      .header("content-disposition", 'attachment; filename="local-voice-flow-dictionary.json"')
      .send(JSON.stringify({ terms }, null, 2));
  });

  app.post("/api/dictionary/preview", async (request, reply) => {
    const parsed = PreviewSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: { code: "bad_request", message: parsed.error.message } });
    }

    const settings = ctx.db.getSettings();
    const terms = ctx.db.listEnabledTerms();
    const replacement = applyDeterministicReplacements(parsed.data.rawTranscript, terms);
    const glossary = selectGlossary(terms, replacement.text, settings.correction.glossaryMaxTerms);
    const profile = resolveProfile(
      parsed.data.bundleId,
      ctx.db.listAppProfiles(),
      settings.correction.profile,
    );

    // The preview shows exactly the bytes that would go to the CLI over stdin. It never
    // includes the system prompt or any environment value.
    const promptPreview = previewCorrectionPayload({
      rawTranscript: replacement.text,
      language: settings.stt.language,
      glossary: glossary.entries,
      profile,
      ...(parsed.data.bundleId ? { bundleId: parsed.data.bundleId } : {}),
    });

    return reply.send({
      rawTranscript: parsed.data.rawTranscript,
      afterReplacements: replacement.text,
      hits: replacement.hits,
      skipped: Array.from(new Set(replacement.skipped)).slice(0, 100),
      glossary: glossary.entries,
      glossaryOmitted: glossary.omitted,
      sttInitialPrompt: buildSttInitialPrompt(terms, settings.stt.glossaryPromptLimit),
      promptPreview,
      profile,
    });
  });
}
