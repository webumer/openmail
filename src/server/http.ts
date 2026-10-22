import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { ImapGateway } from "../mail/imap-gateway.js";
import type { SmtpGateway } from "../mail/smtp-gateway.js";
import type { SendRecorder } from "../services/send-log.js";
import { applySecurityHeaders, type SecurityHeaderOptions } from "../web/headers.js";
import { createMailMcpServer, DEFAULT_USER_ID } from "../tools/register.js";
import type { CredentialStore } from "../store/types.js";
import { authorizeRequest } from "./auth.js";
import { clientAddress } from "../web/request.js";
import { SlidingWindowRateLimit } from "./rate-limit.js";

/** Failed bearer-token attempts per client address per minute before 429. */
export const AUTH_FAILURE_LIMIT = 30;

export const BODY_LIMIT_BYTES = 1024 * 1024;

export interface AuthenticatedKey {
  userId: string;
  keyId: string;
  canSend: boolean;
  via: string;
}

export type RequestAuthenticator = (
  authorizationHeader: string | undefined,
) => Promise<AuthenticatedKey | null> | AuthenticatedKey | null;

/** Returns true when the request was fully handled (including error pages). */
export type WebRequestHandler = (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;

export interface OpenMailServerOptions {
  store: CredentialStore;
  imap: ImapGateway;
  smtp: SmtpGateway;
  sends: SendRecorder;
  /** Shown in send-tool errors so the user can open the dashboard. */
  publicUrl?: string;
  /** Static SHA-256 hashes for single-user mode. Ignored when `authenticate` is set. */
  apiKeyHashes?: readonly Buffer[];
  /** User id paired with static hashes. Ignored when `authenticate` is set. */
  userId?: string;
  /** Resolves a bearer token to a user. Multi-user mode passes a database lookup. */
  authenticate?: RequestAuthenticator;
  rateLimit?: { limit: number; windowMs: number };
  /** Failed-authentication budget per client address. */
  authFailureLimit?: { limit: number; windowMs: number };
  bodyLimitBytes?: number;
  /** Multi-user setup UI on the same origin as `/mcp` and `/healthz`. */
  web?: WebRequestHandler;
  /** Applied to every response, including MCP and health checks. */
  security?: SecurityHeaderOptions;
  /**
   * WWW-Authenticate value for 401s on /mcp. Multi-user mode passes the OAuth
   * challenge (resource_metadata + scope) so MCP clients can discover sign-in.
   */
  challenge?: (invalidToken: boolean) => string;
}

export function createOpenMailServer(options: OpenMailServerOptions): Server {
  const limiter = new SlidingWindowRateLimit(options.rateLimit?.limit ?? 60, options.rateLimit?.windowMs ?? 60_000);
  const failures = new SlidingWindowRateLimit(
    options.authFailureLimit?.limit ?? AUTH_FAILURE_LIMIT,
    options.authFailureLimit?.windowMs ?? 60_000,
  );
  const bodyLimit = options.bodyLimitBytes ?? BODY_LIMIT_BYTES;
  const authenticate =
    options.authenticate ?? staticAuthenticator(options.apiKeyHashes ?? [], options.userId ?? DEFAULT_USER_ID);

  return createServer((req, res) => {
    void handle(req, res, {
      authenticate,
      limiter,
      failures,
      bodyLimit,
      store: options.store,
      imap: options.imap,
      smtp: options.smtp,
      sends: options.sends,
      ...(options.publicUrl ? { publicUrl: options.publicUrl } : {}),
      ...(options.web ? { web: options.web } : {}),
      security: options.security ?? {},
      challenge: options.challenge ?? (() => 'Bearer realm="openmail"'),
    }).catch(() => {
      if (res.headersSent || res.writableEnded) return;
      writeJson(res, 500, { ok: false, error: { code: "internal_error", message: "Internal server error" } });
    });
  });
}

export function listenOn(server: Server, port: number, host: string): Promise<{ host: string; port: number }> {
  return new Promise((resolve, reject) => {
    const onError = (err: Error) => {
      server.off("error", onError);
      reject(err);
    };
    server.on("error", onError);
    server.listen(port, host, () => {
      server.off("error", onError);
      const address = server.address();
      if (!address || typeof address === "string") {
        resolve({ host, port });
        return;
      }
      resolve({ host: address.address, port: address.port });
    });
  });
}

interface HandlerDeps {
  authenticate: RequestAuthenticator;
  limiter: SlidingWindowRateLimit;
  failures: SlidingWindowRateLimit;
  bodyLimit: number;
  store: CredentialStore;
  imap: ImapGateway;
  smtp: SmtpGateway;
  sends: SendRecorder;
  publicUrl?: string;
  web?: WebRequestHandler;
  security: SecurityHeaderOptions;
  challenge: (invalidToken: boolean) => string;
}

/** Browser-based MCP clients (e.g. MCP Inspector) call /mcp cross-origin with a bearer token; no cookies are used. */
const MCP_CORS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
  "access-control-allow-headers": "authorization, content-type, accept, mcp-protocol-version, mcp-session-id, last-event-id",
  "access-control-expose-headers": "www-authenticate, mcp-session-id, mcp-protocol-version",
  "access-control-max-age": "600",
};

function staticAuthenticator(hashes: readonly Buffer[], userId: string): RequestAuthenticator {
  const canSend = process.env.OPENMAIL_SINGLE_USER_CAN_SEND === "1";
  return (authorizationHeader) => {
    const auth = authorizeRequest(authorizationHeader, hashes);
    if (!auth.ok) return null;
    return { userId, keyId: auth.keyId, canSend, via: "api_key:config" };
  };
}

async function handle(req: IncomingMessage, res: ServerResponse, options: HandlerDeps): Promise<void> {
  applySecurityHeaders(req, res, options.security);
  if (options.web && (await options.web(req, res))) return;

  const pathname = requestPath(req);
  if (pathname === "/healthz") {
    if (req.method !== "GET") {
      drain(req);
      writeJson(res, 405, { ok: false, error: { code: "method_not_allowed", message: "Method not allowed" } }, {
        allow: "GET",
      });
      return;
    }
    drain(req);
    writeJson(res, 200, { ok: true });
    return;
  }
  if (pathname !== "/mcp") {
    drain(req);
    writeJson(res, 404, { ok: false, error: { code: "not_found", message: "Not found" } });
    return;
  }

  for (const [name, value] of Object.entries(MCP_CORS)) res.setHeader(name, value);
  if (req.method === "OPTIONS") {
    drain(req);
    res.writeHead(204, { "content-length": 0 });
    res.end();
    return;
  }

  const principal = await options.authenticate(req.headers.authorization);
  if (!principal) {
    drain(req);
    // Keys are 240-bit random, so guessing is hopeless; this only stops a
    // client from hammering the key lookup.
    const address = clientAddress(req, options.security.trustProxy === true);
    if (!options.failures.allow(`mcp-auth:${address}`)) {
      writeJson(
        res,
        429,
        { ok: false, error: { code: "rate_limited", message: "Too many requests" } },
        { "retry-after": "60" },
      );
      return;
    }
    writeJson(
      res,
      401,
      { ok: false, error: { code: "unauthorized", message: "Unauthorized" } },
      { "www-authenticate": options.challenge(req.headers.authorization !== undefined) },
    );
    return;
  }
  if (!options.limiter.allow(principal.keyId)) {
    drain(req);
    writeJson(
      res,
      429,
      { ok: false, error: { code: "rate_limited", message: "Too many requests" } },
      { "retry-after": "60" },
    );
    return;
  }

  const length = declaredLength(req);
  if (length === null || (length !== undefined && length > options.bodyLimit)) {
    drain(req);
    const status = length === null ? 400 : 413;
    const message = length === null ? "Invalid Content-Length" : "Request body exceeds 1 MB";
    writeJson(res, status, { ok: false, error: { code: status === 400 ? "bad_request" : "payload_too_large", message } });
    return;
  }

  if (req.method !== "POST" && req.method !== "GET" && req.method !== "DELETE") {
    drain(req);
    writeJson(res, 405, jsonRpcError("Method not allowed."), { allow: "GET, POST, DELETE" });
    return;
  }

  // Stateless mode has no session to stream or delete. GET and DELETE are
  // recognized and answered 405; each POST builds a new server and transport.
  if (req.method !== "POST") {
    drain(req);
    writeJson(res, 405, jsonRpcError("Method not allowed."), { allow: "GET, POST, DELETE" });
    return;
  }

  const mcp = createMailMcpServer({
    store: options.store,
    imap: options.imap,
    smtp: options.smtp,
    sends: options.sends,
    userId: principal.userId,
    canSend: principal.canSend,
    via: principal.via,
    ...(options.publicUrl ? { publicUrl: options.publicUrl } : {}),
  });
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
    maxRequestBodySize: options.bodyLimit,
  });
  transport.onerror = () => {
    // Returned to the client as a JSON-RPC error. Do not log the request.
  };
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    void transport.close();
    void mcp.close();
  };
  res.on("close", close);
  try {
    await mcp.connect(transport);
    await transport.handleRequest(req, res);
  } catch {
    close();
    if (!res.headersSent) writeJson(res, 500, jsonRpcError("Internal server error"));
  }
}

function requestPath(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? "/", "http://127.0.0.1").pathname;
  } catch {
    return "/";
  }
}

function declaredLength(req: IncomingMessage): number | undefined | null {
  const value = req.headers["content-length"];
  if (value === undefined) return undefined;
  if (Array.isArray(value) || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) return null;
  return parsed;
}

function drain(req: IncomingMessage): void {
  req.resume();
}

function jsonRpcError(message: string): { jsonrpc: "2.0"; error: { code: number; message: string }; id: null } {
  return { jsonrpc: "2.0", error: { code: -32000, message }, id: null };
}

function writeJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  extra?: Record<string, string>,
): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store",
    ...extra,
  });
  res.end(payload);
}
