import type { IncomingMessage, OutgoingHttpHeaders, ServerResponse } from "node:http";

/** Exact policy from the milestone spec. No inline script or style. */
export const CONTENT_SECURITY_POLICY =
  "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; form-action 'self'; frame-ancestors 'none'; base-uri 'none'";

export const HSTS_VALUE = "max-age=31536000; includeSubDomains";

const wrapped = new WeakSet<ServerResponse>();

export interface SecurityHeaderOptions {
  publicUrl?: string;
  trustProxy?: boolean;
}

export function applySecurityHeaders(
  req: IncomingMessage,
  res: ServerResponse,
  options: SecurityHeaderOptions,
): void {
  if (wrapped.has(res)) return;
  wrapped.add(res);
  const forced: OutgoingHttpHeaders = {
    "content-security-policy": CONTENT_SECURITY_POLICY,
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
  };
  if (shouldSendHsts(req, options)) forced["strict-transport-security"] = HSTS_VALUE;
  for (const [name, value] of Object.entries(forced)) {
    if (value !== undefined) res.setHeader(name, value);
  }

  const original = res.writeHead.bind(res);
  res.writeHead = ((statusCode: number, ...rest: unknown[]) => {
    if (!res.headersSent) {
      for (const [name, value] of Object.entries(forced)) {
        if (value !== undefined && res.getHeader(name) === undefined) res.setHeader(name, value);
      }
    }
    if (rest.length === 0) return original(statusCode, forced);
    if (typeof rest[0] === "string") {
      const headers =
        rest[1] && typeof rest[1] === "object" && !Array.isArray(rest[1])
          ? { ...(rest[1] as OutgoingHttpHeaders), ...forced }
          : forced;
      return original(statusCode, rest[0], headers);
    }
    if (Array.isArray(rest[0])) {
      const copy: (string | number)[] = [...rest[0]];
      for (const [name, value] of Object.entries(forced)) {
        if (typeof value === "string" || typeof value === "number") copy.push(name, value);
      }
      return original(statusCode, copy);
    }
    if (rest[0] && typeof rest[0] === "object") {
      return original(statusCode, { ...(rest[0] as OutgoingHttpHeaders), ...forced });
    }
    return original(statusCode, forced);
  }) as typeof res.writeHead;
}

export function shouldSendHsts(req: IncomingMessage, options: SecurityHeaderOptions): boolean {
  const publicUrl = options.publicUrl?.trim().toLowerCase();
  if (publicUrl?.startsWith("https://")) return true;
  const socket = req.socket as { encrypted?: boolean };
  if (socket.encrypted === true) return true;
  if (options.trustProxy !== true) return false;
  return forwardedProto(req) === "https";
}

function forwardedProto(req: IncomingMessage): string | undefined {
  const header = req.headers["x-forwarded-proto"];
  const raw = Array.isArray(header) ? header[0] : header;
  return raw?.split(",")[0]?.trim().toLowerCase();
}
