import { createReadStream, existsSync, rmSync } from "node:fs";
import { z } from "zod";
import {
  DictationContextSchema,
  HistoryQuerySchema,
  RecordingModeSchema,
  ReprocessRequestSchema,
  type DictationRecord,
} from "@lvf/shared";
import type { FastifyInstance } from "fastify";
import type { ServerContext } from "../context.js";

const BulkDeleteSchema = z.object({ ids: z.array(z.string().max(80)).max(1000) });
const EditSchema = z.object({ finalText: z.string().max(200_000) });

/**
 * Headers carry metadata so the body can be the raw WAV with no multipart parsing.
 *
 * Every field here is advisory — the window title, the peak level, the reported duration.
 * The audio is not: it exists exactly once and cannot be re-recorded. So each value is
 * normalised into the range the schema accepts instead of being validated against it; a
 * header the agent got wrong must never cost the user a three-minute dictation.
 */
function readContext(headers: Record<string, unknown>) {
  const get = (name: string): string | undefined => {
    const value = headers[name];
    return typeof value === "string" && value.length > 0 ? value : undefined;
  };
  const decode = (value: string | undefined, limit: number): string | undefined => {
    if (value === undefined) return undefined;
    let text = value;
    try {
      text = decodeURIComponent(value);
    } catch {
      // Not percent-encoded (or malformed) — take it literally.
    }
    return text.slice(0, limit);
  };
  const num = (value: string | undefined): number | undefined => {
    if (value === undefined) return undefined;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.max(0, parsed) : undefined;
  };
  const mode = get("x-lvf-recording-mode");
  const pid = num(get("x-lvf-pid"));

  return DictationContextSchema.parse({
    recordingMode: RecordingModeSchema.safeParse(mode).success ? mode : "push-to-talk",
    appName: decode(get("x-lvf-app-name"), 200),
    bundleId: decode(get("x-lvf-bundle-id"), 200),
    windowTitle: decode(get("x-lvf-window-title"), 500),
    ...(pid !== undefined ? { pid: Math.floor(pid) } : {}),
    audioDurationMs: num(get("x-lvf-audio-duration-ms")),
    peakAmplitude: num(get("x-lvf-peak-amplitude")),
  });
}

function toCsv(records: readonly DictationRecord[]): string {
  const columns = [
    "id",
    "createdAt",
    "status",
    "appName",
    "bundleId",
    "recordingMode",
    "audioDurationMs",
    "rawTranscript",
    "finalText",
    "detectedLanguage",
    "sttModel",
    "llmProvider",
    "llmModel",
    "llmEffort",
    "sttLatencyMs",
    "llmLatencyMs",
    "totalLatencyMs",
    "errorCode",
  ] as const;

  const escape = (value: unknown): string => {
    if (value === undefined || value === null) return "";
    let text = String(value);
    // A leading =, +, - or @ turns a cell into a formula in Excel/Sheets; the standard
    // apostrophe prefix makes the export inert without losing the text.
    if (/^[=+\-@]/.test(text)) text = `'${text}`;
    return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };

  const lines = [columns.join(",")];
  for (const record of records) {
    lines.push(columns.map((column) => escape(record[column])).join(","));
  }
  return lines.join("\n");
}

/**
 * Projects a stored record back onto the outcome shape the agent inserts from.
 *
 * A record whose run was torn down mid-flight (the agent's connection dropped) still
 * holds the transcript, so the words are recoverable even though the corrected text is
 * not — but only when the user asked for that fallback in settings.
 */
function outcomeOf(record: DictationRecord, insertRawWhenLlmFails: boolean) {
  const final = record.finalText?.trim() ?? "";
  const raw = record.rawTranscript?.trim() ?? "";
  const salvageable = record.status === "failed" || record.status === "cancelled";
  const useRaw = final.length === 0 && salvageable && insertRawWhenLlmFails && raw.length > 0;
  const text = final.length > 0 ? final : useRaw ? raw : undefined;

  return {
    id: record.id,
    status: record.status,
    ...(text !== undefined ? { text } : {}),
    // "raw" covers both paths that hand back an uncorrected transcript: the pipeline's own
    // fallback (which already stored it as finalText) and this salvage.
    isRawFallback: useRaw || (record.status === "failed" && final.length > 0),
    ...(record.audioDurationMs !== undefined ? { audioDurationMs: record.audioDurationMs } : {}),
    ...(record.sttLatencyMs !== undefined ? { sttLatencyMs: record.sttLatencyMs } : {}),
    ...(record.llmLatencyMs !== undefined ? { llmLatencyMs: record.llmLatencyMs } : {}),
    ...(record.totalLatencyMs !== undefined ? { totalLatencyMs: record.totalLatencyMs } : {}),
    ...(record.errorCode ? { errorCode: record.errorCode } : {}),
    ...(record.errorMessage ? { errorMessage: record.errorMessage } : {}),
    warnings: record.warnings ?? [],
  };
}

export function registerDictationRoutes(app: FastifyInstance, ctx: ServerContext): void {
  app.post("/api/dictations", async (request, reply) => {
    const body = request.body;
    if (!Buffer.isBuffer(body) || body.byteLength === 0) {
      return reply
        .code(400)
        .send({ error: { code: "audio_invalid", message: "expected a non-empty audio/wav body" } });
    }
    // "RIFF" — reject anything that is not actually a WAV before it reaches the worker.
    if (body.byteLength < 44 || body.subarray(0, 4).toString("ascii") !== "RIFF") {
      return reply
        .code(400)
        .send({ error: { code: "audio_invalid", message: "body is not a RIFF/WAV stream" } });
    }

    let context;
    try {
      context = readContext(request.headers as Record<string, unknown>);
    } catch (error) {
      return reply
        .code(400)
        .send({ error: { code: "audio_invalid", message: `bad metadata: ${String(error)}` } });
    }

    const idHeader = request.headers["x-lvf-dictation-id"];
    const dictationId =
      typeof idHeader === "string" && /^[A-Za-z0-9_-]{1,80}$/.test(idHeader) ? idHeader : undefined;

    // A reused id would make two captures share one history row — and could paste one
    // user's words into the other's field. No await sits between this check and
    // `pipeline.run()` registering the id, so the check cannot race a concurrent POST.
    if (dictationId && (ctx.pipeline.isInflight(dictationId) || ctx.db.getDictation(dictationId))) {
      return reply
        .code(409)
        .send({ error: { code: "conflict", message: `dictation id ${dictationId} is already in use` } });
    }

    const controller = new AbortController();
    // A client that walks away deliberately does NOT tear the run down. `req.on("aborted")`
    // never fires once the body is fully uploaded (verified against Node's http server), so
    // the listener that used to sit here was dead code — and finishing the run is the better
    // behaviour anyway: the record lands in the database and `/outcome` can hand the text to
    // an agent whose connection died at the finish line. Deliberate cancellation goes
    // through `POST /api/dictations/:id/cancel`, and shutdown through `cancelAll()`.
    reply.raw.on("close", () => {
      if (!reply.raw.writableFinished) {
        ctx.logger.warn("client stopped waiting; finishing the run so the text is recoverable", {
          dictationId: dictationId ?? "(generated)",
        });
      }
    });

    const outcome = await ctx.pipeline.run({
      audio: body,
      context,
      signal: controller.signal,
      ...(dictationId ? { dictationId } : {}),
    });

    return reply.send(outcome);
  });

  app.post<{ Params: { id: string } }>("/api/dictations/:id/cancel", async (request, reply) => {
    const cancelled = ctx.pipeline.cancel(request.params.id);
    return reply.send({ cancelled });
  });

  app.get("/api/dictations", async (request, reply) => {
    const query = HistoryQuerySchema.parse(request.query);
    return reply.send(ctx.db.listDictations(query));
  });

  app.get("/api/dictations/export", async (request, reply) => {
    const query = HistoryQuerySchema.parse({
      ...(request.query as Record<string, unknown>),
      limit: 500,
      offset: 0,
    });
    const format = (request.query as { format?: string }).format ?? "json";
    // Export walks the whole matching set, not just one page.
    const all: DictationRecord[] = [];
    for (let offset = 0; ; offset += 500) {
      const page = ctx.db.listDictations({ ...query, limit: 500, offset });
      all.push(...page.items);
      if (page.items.length < 500 || all.length >= page.total) break;
    }

    if (format === "csv") {
      return reply
        .header("content-type", "text/csv; charset=utf-8")
        .header("content-disposition", 'attachment; filename="local-voice-flow-history.csv"')
        .send(toCsv(all));
    }
    return reply
      .header("content-type", "application/json; charset=utf-8")
      .header("content-disposition", 'attachment; filename="local-voice-flow-history.json"')
      .send(JSON.stringify({ items: all }, null, 2));
  });

  app.get<{ Params: { id: string } }>("/api/dictations/:id", async (request, reply) => {
    const record = ctx.db.getDictation(request.params.id);
    if (!record) {
      return reply.code(404).send({ error: { code: "not_found", message: "no such dictation" } });
    }
    return reply.send(record);
  });

  /**
   * The insertable result of a dictation, in the same shape the POST returns.
   *
   * The agent calls this when its own POST connection died (a client-side timeout, a
   * core restart) but the run itself may well have finished: the text is then already in
   * the database and only the answer was lost. `202` means "still running, ask again";
   * anything else is final.
   */
  app.get<{ Params: { id: string } }>("/api/dictations/:id/outcome", async (request, reply) => {
    const id = request.params.id;
    if (ctx.pipeline.isInflight(id)) {
      return reply.code(202).send({ id, status: "correcting", pending: true });
    }
    const record = ctx.db.getDictation(id);
    if (!record) {
      return reply.code(404).send({ error: { code: "not_found", message: "no such dictation" } });
    }
    return reply.send(outcomeOf(record, ctx.db.getSettings().general.insertRawTranscriptWhenLlmFails));
  });

  app.get<{ Params: { id: string } }>("/api/dictations/:id/audio", async (request, reply) => {
    const record = ctx.db.getDictation(request.params.id);
    // Only a path this server itself wrote is ever served; the client cannot name a file.
    if (!record?.audioPath || !existsSync(record.audioPath)) {
      return reply.code(404).send({ error: { code: "not_found", message: "no stored audio" } });
    }
    return reply.header("content-type", "audio/wav").send(createReadStream(record.audioPath));
  });

  app.patch<{ Params: { id: string } }>("/api/dictations/:id", async (request, reply) => {
    const parsed = EditSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: { code: "bad_request", message: parsed.error.message } });
    }
    const updated = ctx.db.updateDictation(request.params.id, { finalText: parsed.data.finalText });
    if (!updated) {
      return reply.code(404).send({ error: { code: "not_found", message: "no such dictation" } });
    }
    return reply.send(updated);
  });

  app.post<{ Params: { id: string } }>("/api/dictations/:id/reprocess", async (request, reply) => {
    const parsed = ReprocessRequestSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: { code: "bad_request", message: parsed.error.message } });
    }
    // Reprocessing an id that is still in flight (a live dictation, or an earlier
    // reprocess) would overwrite its abort controller, so Esc would abort the wrong run.
    // No await sits between this check and `pipeline.reprocess()` registering the id.
    if (ctx.pipeline.isInflight(request.params.id)) {
      return reply.code(409).send({
        error: {
          code: "conflict",
          message: `dictation ${request.params.id} is still being processed`,
        },
      });
    }
    try {
      const record = await ctx.pipeline.reprocess(request.params.id, parsed.data);
      return reply.send(record);
    } catch (error) {
      const code = (error as { code?: string }).code ?? "internal";
      return reply
        .code(code === "internal" ? 500 : 502)
        .send({ error: { code, message: (error as Error).message } });
    }
  });

  app.post("/api/dictations/delete", async (request, reply) => {
    const parsed = BulkDeleteSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: { code: "bad_request", message: parsed.error.message } });
    }
    for (const id of parsed.data.ids) {
      const record = ctx.db.getDictation(id);
      if (record?.audioPath) rmSync(record.audioPath, { force: true });
    }
    return reply.send({ deleted: ctx.db.deleteDictations(parsed.data.ids) });
  });

  app.delete<{ Params: { id: string } }>("/api/dictations/:id", async (request, reply) => {
    const record = ctx.db.getDictation(request.params.id);
    if (record?.audioPath) rmSync(record.audioPath, { force: true });
    const deleted = ctx.db.deleteDictation(request.params.id);
    if (!deleted) {
      return reply.code(404).send({ error: { code: "not_found", message: "no such dictation" } });
    }
    return reply.send({ deleted: true });
  });

  app.delete("/api/dictations", async (request, reply) => {
    const confirm = (request.query as { confirm?: string }).confirm;
    if (confirm !== "yes") {
      return reply
        .code(400)
        .send({ error: { code: "bad_request", message: "pass ?confirm=yes to clear history" } });
    }
    for (const path of ctx.db.allAudioPaths()) rmSync(path, { force: true });
    return reply.send({ deleted: ctx.db.clearDictations() });
  });
}
