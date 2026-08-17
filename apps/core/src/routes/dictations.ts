import { createReadStream, existsSync, rmSync } from "node:fs";
import { z } from "zod";
import {
  DictationContextSchema,
  HistoryQuerySchema,
  ReprocessRequestSchema,
  type DictationRecord,
} from "@lvf/shared";
import type { FastifyInstance } from "fastify";
import type { ServerContext } from "../context.js";

const BulkDeleteSchema = z.object({ ids: z.array(z.string().max(80)).max(1000) });
const EditSchema = z.object({ finalText: z.string().max(200_000) });

/** Headers carry metadata so the body can be the raw WAV with no multipart parsing. */
function readContext(headers: Record<string, unknown>) {
  const get = (name: string): string | undefined => {
    const value = headers[name];
    return typeof value === "string" && value.length > 0 ? value : undefined;
  };
  const decode = (value: string | undefined): string | undefined => {
    if (value === undefined) return undefined;
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  };
  const num = (value: string | undefined): number | undefined => {
    if (value === undefined) return undefined;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  };

  return DictationContextSchema.parse({
    recordingMode: get("x-lvf-recording-mode") ?? "push-to-talk",
    appName: decode(get("x-lvf-app-name")),
    bundleId: get("x-lvf-bundle-id"),
    windowTitle: decode(get("x-lvf-window-title")),
    pid: num(get("x-lvf-pid")),
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
    const text = String(value);
    return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };

  const lines = [columns.join(",")];
  for (const record of records) {
    lines.push(columns.map((column) => escape(record[column])).join(","));
  }
  return lines.join("\n");
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

    const controller = new AbortController();
    // A dropped connection (the agent quit, the user cancelled) must tear the pipeline down.
    request.raw.on("aborted", () => controller.abort());

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
