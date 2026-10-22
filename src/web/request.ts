import { readFileSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const FILES = new Map<string, { type: string; body: Buffer }>([
  ["/static/style.css", { type: "text/css; charset=utf-8", body: readStatic("style.css") }],
  ["/static/app.js", { type: "text/javascript; charset=utf-8", body: readStatic("app.js") }],
  ["/static/site.js", { type: "text/javascript; charset=utf-8", body: readStatic("site.js") }],
  ["/og.png", { type: "image/png", body: readStatic("og.png") }],
  ["/logo.svg", { type: "image/svg+xml", body: readStatic("logo.svg") }],
  ["/logo.png", { type: "image/png", body: readStatic("logo.png") }],
  ["/favicon.ico", { type: "image/png", body: readStatic("logo.png") }],
]);

/** Markdown source for the public reviewer guide at /reviewers. */
export function reviewerGuideMarkdown(): string {
  return readStatic("reviewer-guide.md").toString("utf8");
}

export function staticFile(pathname: string): { type: string; body: Buffer } | undefined {
  return FILES.get(pathname);
}

function readStatic(name: string): Buffer {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [join(here, "static", name), join(here, "../../src/web/static", name)];
  for (const path of candidates) {
    try {
      return readFileSync(path);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") throw err;
    }
  }
  throw new Error(`OpenMail static file not found: ${name}`);
}

export function requestUrl(req: IncomingMessage): URL {
  try {
    return new URL(req.url ?? "/", "http://127.0.0.1");
  } catch {
    return new URL("http://127.0.0.1/");
  }
}

export function clientAddress(req: IncomingMessage, trustProxy: boolean): string {
  if (trustProxy) {
    const header = req.headers["x-forwarded-for"];
    // The trusted proxy appends the address it saw, so the last entry is the
    // one a client cannot forge.
    const raw = Array.isArray(header) ? header.join(",") : header;
    const last = raw?.split(",").map((part) => part.trim()).filter(Boolean).pop();
    if (last) return last.slice(0, 200);
  }
  return req.socket.remoteAddress ?? "unknown";
}

export async function readBody(
  req: IncomingMessage,
  limit: number,
): Promise<{ ok: true; body: Buffer } | { ok: false; status: 400 | 413; message: string }> {
  const declared = declaredLength(req);
  if (declared === null) {
    req.resume();
    return { ok: false, status: 400, message: "Invalid Content-Length" };
  }
  if (declared !== undefined && declared > limit) {
    req.resume();
    return { ok: false, status: 413, message: "Request body exceeds 1 MB" };
  }
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for await (const chunk of req) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buf.length;
      if (total > limit) {
        req.resume();
        return { ok: false, status: 413, message: "Request body exceeds 1 MB" };
      }
      chunks.push(buf);
    }
  } catch {
    req.resume();
    return { ok: false, status: 400, message: "Could not read the request body" };
  }
  return { ok: true, body: Buffer.concat(chunks) };
}

const KNOWN_FIELDS = new Set([
  "_csrf",
  "next",
  "email",
  "password",
  "name",
  "username",
  "preset",
  "zoho_region",
  "imap_host",
  "imap_port",
  "imap_secure",
  "smtp_host",
  "smtp_port",
  "smtp_secure",
  "smtp_starttls",
  "smtp_security",
  "smtp_username",
  "smtp_password",
  "permission",
  "enabled",
]);

export function formFields(body: Buffer): Record<string, string> {
  const params = new URLSearchParams(body.toString("utf8"));
  const fields: Record<string, string> = {};
  for (const [key, value] of params) {
    if (!KNOWN_FIELDS.has(key) || Object.hasOwn(fields, key)) continue;
    fields[key] = value;
  }
  return fields;
}

export function isFormContentType(header: string | undefined): boolean {
  if (!header) return false;
  const type = header.split(";")[0]?.trim().toLowerCase();
  return type === "application/x-www-form-urlencoded";
}

function declaredLength(req: IncomingMessage): number | undefined | null {
  const value = req.headers["content-length"];
  if (value === undefined) return undefined;
  if (Array.isArray(value) || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) return null;
  return parsed;
}
