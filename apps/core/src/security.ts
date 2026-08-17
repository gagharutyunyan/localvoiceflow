import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes, timingSafeEqual } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";

export const SESSION_COOKIE = "lvf_session";

/**
 * Loads the loopback API token, creating it on first run.
 *
 * The file is the security boundary: only processes running as this user can read it,
 * which is what stops another local program (or a web page, which cannot read files at
 * all) from driving the API.
 */
export function loadOrCreateToken(tokenFile: string): string {
  if (existsSync(tokenFile)) {
    const existing = readFileSync(tokenFile, "utf8").trim();
    if (existing.length >= 32) {
      chmodSync(tokenFile, 0o600);
      return existing;
    }
  }
  const token = randomBytes(32).toString("hex");
  writeFileSync(tokenFile, `${token}\n`, { mode: 0o600, encoding: "utf8" });
  chmodSync(tokenFile, 0o600);
  return token;
}

/** Constant-time comparison; a length mismatch alone is not a timing leak worth having. */
export function tokensMatch(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export function parseCookies(header: string | undefined): Record<string, string> {
  if (!header) return {};
  const out: Record<string, string> = {};
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx <= 0) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (key.length > 0) out[key] = decodeURIComponent(value);
  }
  return out;
}

const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export interface AuthOptions {
  token: string;
  sessionToken: string;
  allowedOrigins: readonly string[];
  /** Paths that skip authentication entirely (liveness only). */
  publicPaths: ReadonlySet<string>;
}

/**
 * Authenticates a request and enforces the same-origin rule for anything mutating.
 *
 * Two credentials are accepted, deliberately different in kind:
 *  - `Authorization: Bearer <token>` — used by the macOS agent, which can read the file.
 *  - the `lvf_session` cookie — issued by `GET /session?token=…` so the browser gets in
 *    without the token ever being visible to page JavaScript.
 *
 * The Origin check matters because a cookie is sent automatically: without it, any page
 * the user visits could POST to 127.0.0.1 and drive this API.
 */
export function authenticate(
  request: FastifyRequest,
  reply: FastifyReply,
  options: AuthOptions,
): boolean {
  const url = request.url.split("?")[0] ?? "";
  if (options.publicPaths.has(url)) return true;

  const origin = request.headers.origin;
  if (typeof origin === "string" && origin.length > 0) {
    if (!options.allowedOrigins.includes(origin)) {
      reply.code(403).send({ error: { code: "forbidden", message: "origin not allowed" } });
      return false;
    }
  } else if (MUTATING_METHODS.has(request.method)) {
    // A browser always sends Origin on a cross-origin mutating request, so its absence
    // means a non-browser client — which must then present the bearer token.
    const header = request.headers.authorization;
    if (typeof header !== "string" || !header.startsWith("Bearer ")) {
      reply
        .code(403)
        .send({ error: { code: "forbidden", message: "missing Origin or bearer token" } });
      return false;
    }
  }

  const authHeader = request.headers.authorization;
  if (typeof authHeader === "string" && authHeader.startsWith("Bearer ")) {
    if (tokensMatch(authHeader.slice("Bearer ".length).trim(), options.token)) return true;
  }

  const cookies = parseCookies(request.headers.cookie);
  const session = cookies[SESSION_COOKIE];
  if (session && tokensMatch(session, options.sessionToken)) return true;

  reply.code(401).send({ error: { code: "unauthorized", message: "authentication required" } });
  return false;
}

export function buildSessionCookie(sessionToken: string): string {
  // No Secure flag: the dashboard is plain HTTP on loopback, and marking it Secure would
  // make the browser drop it outright.
  return [
    `${SESSION_COOKIE}=${encodeURIComponent(sessionToken)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    `Max-Age=${60 * 60 * 24 * 30}`,
  ].join("; ");
}
