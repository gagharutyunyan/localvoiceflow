import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { ZodError } from "zod";
import fastifyStatic from "@fastify/static";
import { APP_VERSION, PipelineError, type ServerEvent, type StatusResponse } from "@lvf/shared";
import type { ServerContext } from "./context.js";
import { authenticate, buildSessionCookie, loadOrCreateToken, tokensMatch } from "./security.js";
import { registerDictationRoutes } from "./routes/dictations.js";
import { registerDictionaryRoutes } from "./routes/dictionary.js";
import { registerSettingsRoutes } from "./routes/settings.js";
import { registerDiagnosticsRoutes } from "./routes/diagnostics.js";

const MAX_UPLOAD_BYTES = 64 * 1024 * 1024;

const PUBLIC_PATHS = new Set(["/api/health"]);

export interface BuildServerOptions {
  ctx: ServerContext;
  /** Absolute path to the built web UI; when absent the API still works. */
  webDir?: string;
  /**
   * Additionally trust the Vite dev-server origin (port 5173). Defaults to `LVF_DEV=1`,
   * so a production install never trusts a port any other local tool may be serving on.
   */
  allowDevOrigins?: boolean;
}

export interface BuiltServer {
  app: FastifyInstance;
  token: string;
  sessionToken: string;
  dashboardUrl: (host: string, port: number) => string;
  /** Ends every open SSE stream. Must run before `app.close()`, which waits on them. */
  closeEventStreams: () => void;
}

export function buildServer(options: BuildServerOptions): BuiltServer {
  const { ctx } = options;

  const token = loadOrCreateToken(ctx.paths.tokenFile);
  // A separate value: the cookie is exposed to the browser, the file token is not, so a
  // leaked cookie cannot be replayed as a bearer credential.
  const sessionToken = randomBytes(32).toString("hex");

  /** Teardown callbacks for the currently open SSE streams. */
  const openEventStreams = new Set<() => void>();

  const app = Fastify({
    logger: false,
    bodyLimit: MAX_UPLOAD_BYTES,
    trustProxy: false,
  });

  // The agent posts the WAV as a raw body; Fastify needs to be told to keep it a Buffer.
  app.addContentTypeParser(
    ["audio/wav", "audio/x-wav", "audio/wave", "application/octet-stream"],
    { parseAs: "buffer" },
    (_request, body, done) => {
      done(null, body);
    },
  );

  // The Vite dev origin is opt-in: `make dev` does not need it (the Vite proxy rewrites
  // Origin to core's own), so only an explicit LVF_DEV=1 — someone pointing a bare Vite
  // server straight at core — widens the list beyond core's own origin.
  const allowDevOrigins = options.allowDevOrigins ?? process.env.LVF_DEV === "1";
  const allowedOrigins = [
    `http://127.0.0.1:${ctx.port}`,
    `http://localhost:${ctx.port}`,
    ...(allowDevOrigins ? ["http://127.0.0.1:5173", "http://localhost:5173"] : []),
  ];

  app.addHook("onRequest", async (request, reply) => {
    const url = request.url.split("?")[0] ?? "";
    // Static assets and the session handshake authenticate themselves.
    if (url === "/session") return;
    if (!url.startsWith("/api/")) return;
    if (!authenticate(request, reply, { token, sessionToken, allowedOrigins, publicPaths: PUBLIC_PATHS })) {
      return reply;
    }
    return;
  });

  app.setErrorHandler((error: unknown, request, reply) => {
    // A schema violation is bad input, not a server fault. Some of it is only detectable
    // after a patch is merged with the stored settings (a provider/effort combination, for
    // instance), so it surfaces as a thrown ZodError from deep inside the write path
    // rather than at the route's own safeParse. Mapping it here keeps every such route
    // answering 400 with the offending field instead of a misleading 500.
    if (error instanceof ZodError) {
      const message = error.issues
        .map((issue) => {
          const path = issue.path.join(".");
          return path ? `${path}: ${issue.message}` : issue.message;
        })
        .join("; ");
      ctx.logger.warn("request rejected", {
        method: request.method,
        path: request.url.split("?")[0],
        code: "bad_request",
      });
      return reply.code(400).send({ error: { code: "bad_request", message } });
    }

    const pipelineError = error instanceof PipelineError ? error : undefined;
    const code = pipelineError?.code ?? "internal";
    const message = (error instanceof Error && error.message) || "internal error";

    ctx.setLastError(code, message);
    ctx.logger.error("request failed", {
      method: request.method,
      path: request.url.split("?")[0],
      code,
    });

    const status = (error as { statusCode?: number }).statusCode ?? (pipelineError ? 502 : 500);
    return reply.code(status).send({ error: { code, message } });
  });

  // -------------------------------------------------------------------------
  // Session handshake
  // -------------------------------------------------------------------------

  app.get("/session", async (request, reply) => {
    const provided = (request.query as { token?: string }).token ?? "";
    if (!provided || !tokensMatch(provided, token)) {
      return reply
        .code(401)
        .type("text/html; charset=utf-8")
        .send(
          "<h1>LocalVoiceFlow</h1><p>Неверный или отсутствующий токен. Откройте панель из меню приложения или командой <code>make start</code>.</p>",
        );
    }
    const next = (request.query as { next?: string }).next;
    // Only an in-app path is ever accepted here, so this cannot become an open redirect.
    const target = typeof next === "string" && /^\/[A-Za-z0-9/_-]*$/.test(next) ? next : "/";
    return reply.header("set-cookie", buildSessionCookie(sessionToken)).redirect(target, 302);
  });

  // -------------------------------------------------------------------------
  // Health, status, events
  // -------------------------------------------------------------------------

  app.get("/api/health", async (_request, reply) => {
    return reply.send({ ok: true, version: APP_VERSION, uptimeMs: Date.now() - ctx.startedAt });
  });

  app.get("/api/status", async (_request, reply) => {
    const sttHealth = await ctx.stt.health();
    const settings = ctx.db.getSettings();
    const last = ctx.db.lastDictation();

    const response: StatusResponse = {
      version: APP_VERSION,
      state: sttHealth.ready ? "ok" : sttHealth.state === "error" ? "error" : "degraded",
      uptimeMs: Date.now() - ctx.startedAt,
      port: ctx.port,
      stt: {
        ready: sttHealth.ready,
        state: sttHealth.state,
        backend: sttHealth.backend,
        ...(sttHealth.model ? { model: sttHealth.model } : {}),
        ...(sttHealth.device ? { device: sttHealth.device } : {}),
        ...(sttHealth.loadMs !== undefined ? { loadMs: sttHealth.loadMs } : {}),
        ...(sttHealth.error ? { error: sttHealth.error } : {}),
        ...(sttHealth.restarts !== undefined ? { restarts: sttHealth.restarts } : {}),
      },
      correction: {
        provider: settings.correction.provider,
        model: settings.correction.model,
        effort: settings.correction.effort,
        profile: settings.correction.profile,
      },
      permissions: {
        microphone: ctx.agentStatus.microphone,
        accessibility: ctx.agentStatus.accessibility,
        inputMonitoring: ctx.agentStatus.inputMonitoring,
        ...(ctx.agentStatus.reportedAt ? { reportedAt: ctx.agentStatus.reportedAt } : {}),
        agentConnected: ctx.agentStatus.agentConnected,
      },
      ...(last
        ? {
            lastDictation: {
              id: last.id,
              createdAt: last.createdAt,
              status: last.status,
              ...(last.totalLatencyMs !== undefined ? { totalLatencyMs: last.totalLatencyMs } : {}),
              ...(last.sttLatencyMs !== undefined ? { sttLatencyMs: last.sttLatencyMs } : {}),
              ...(last.llmLatencyMs !== undefined ? { llmLatencyMs: last.llmLatencyMs } : {}),
            },
          }
        : {}),
      ...(ctx.lastError ? { lastError: ctx.lastError } : {}),
    };

    return reply.send(response);
  });

  app.get("/api/events", async (request, reply) => {
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      // Nginx-style buffering would defeat the whole point of SSE if one ever appeared.
      "x-accel-buffering": "no",
    });

    const send = (event: ServerEvent) => {
      reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
    };

    send({ type: "hello", at: new Date().toISOString(), version: APP_VERSION });
    for (const event of ctx.events.recent()) send(event);

    const unsubscribe = ctx.events.subscribe(send);
    // A comment line keeps the connection alive through idle proxies and lets the client
    // notice a dead server quickly.
    const heartbeat = setInterval(() => reply.raw.write(": ping\n\n"), 15_000);

    const close = () => {
      clearInterval(heartbeat);
      unsubscribe();
      openEventStreams.delete(close);
      reply.raw.end();
    };

    // An event stream is a request that never finishes on its own, and `app.close()` waits
    // for in-flight requests. Without this registry a restart left the old process alive
    // forever: it dropped its listening socket, so the new one bound the port, but it kept
    // the agent's stream open — the agent never saw a disconnect and never re-registered
    // with the new process, leaving the two halves talking to different cores.
    openEventStreams.add(close);

    request.raw.on("close", () => {
      clearInterval(heartbeat);
      unsubscribe();
      openEventStreams.delete(close);
    });

    return reply;
  });

  // -------------------------------------------------------------------------
  // Feature routes
  // -------------------------------------------------------------------------

  registerDictationRoutes(app, ctx);
  registerDictionaryRoutes(app, ctx);
  registerSettingsRoutes(app, ctx);
  registerDiagnosticsRoutes(app, ctx);

  // -------------------------------------------------------------------------
  // Static web UI
  // -------------------------------------------------------------------------

  const webDir = options.webDir;
  if (webDir && existsSync(join(webDir, "index.html"))) {
    void app.register(fastifyStatic, { root: webDir, prefix: "/", index: ["index.html"] });
    // Client-side routing: any non-API path falls back to the SPA shell.
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith("/api/")) {
        return reply.code(404).send({ error: { code: "not_found", message: "no such endpoint" } });
      }
      return reply.sendFile("index.html");
    });
  } else {
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith("/api/")) {
        return reply.code(404).send({ error: { code: "not_found", message: "no such endpoint" } });
      }
      return reply
        .code(404)
        .type("text/html; charset=utf-8")
        .send(
          "<h1>LocalVoiceFlow</h1><p>Веб-интерфейс не собран. Выполните <code>make build</code>.</p>",
        );
    });
  }

  return {
    app,
    token,
    sessionToken,
    dashboardUrl: (host, port) => `http://${host}:${port}/session?token=${token}`,
    closeEventStreams: () => {
      // Iterate a copy: each callback removes itself from the set.
      for (const close of [...openEventStreams]) close();
      openEventStreams.clear();
    },
  };
}
