import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { ImapGateway } from "../mail/imap-gateway.js";
import { applySecurityHeaders, type SecurityHeaderOptions } from "../web/headers.js";
import { createMailMcpServer, DEFAULT_USER_ID } from "../tools/register.js";
import type { CredentialStore } from "../store/types.js";
import { authorizeRequest } from "./auth.js";
import { SlidingWindowRateLimit } from "./rate-limit.js";

export const BODY_LIMIT_BYTES = 1024 * 1024;

export interface AuthenticatedKey {
  userId: string;
  keyId: string;
}

export type RequestAuthenticator = (
  authorizationHeader: string | undefined,
) => Promise<AuthenticatedKey | null> | AuthenticatedKey | null;

/** Returns true when the request was fully handled (including error pages). */
export type WebRequestHandler = (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;

export interface OpenMailServerOptions {
  store: CredentialStore;
  imap: ImapGateway;
  /** Static SHA-256 hashes for single-user mode. Ignored when `authenticate` is set. */
  apiKeyHashes?: readonly Buffer[];
  /** User id paired with static hashes. Ignored when `authenticate` is set. */
  userId?: string;
  /** Resolves a bearer token to a user. Multi-user mode passes a database lookup. */
  authenticate?: RequestAuthenticator;
  rateLimit?: { limit: number; windowMs: number };
  bodyLimitBytes?: number;
  /** Multi-user setup UI on the same origin as `/mcp` and `/healthz`. */
  web?: WebRequestHandler;
  /** Applied to every response, including MCP and health checks. */
  security?: SecurityHeaderOptions;
}

export function createOpenMailServer(options: OpenMailServerOptions): Server {
  const limiter = new SlidingWindowRateLimit(options.rateLimit?.limit ?? 60, options.rateLimit?.windowMs ?? 60_000);
  const bodyLimit = options.bodyLimitBytes ?? BODY_LIMIT_BYTES;
  const authenticate =
    options.authenticate ?? staticAuthenticator(options.apiKeyHashes ?? [], options.userId ?? DEFAULT_USER_ID);

  return createServer((req, res) => {
    void handle(req, res, {
      authenticate,
      limiter,
      bodyLimit,
      store: options.store,
      imap: options.imap,
      ...(options.web ? { web: options.web } : {}),
      security: options.security ?? {},
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
  bodyLimit: number;
  store: CredentialStore;
  imap: ImapGateway;
  web?: WebRequestHandler;
  security: SecurityHeaderOptions;
}

function staticAuthenticator(hashes: readonly Buffer[], userId: string): RequestAuthenticator {
  return (authorizationHeader) => {
    const auth = authorizeRequest(authorizationHeader, hashes);
    if (!auth.ok) return null;
    return { userId, keyId: auth.keyId };
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

  const principal = await options.authenticate(req.headers.authorization);
  if (!principal) {
    drain(req);
    writeJson(
      res,
      401,
      { ok: false, error: { code: "unauthorized", message: "Unauthorized" } },
      { "www-authenticate": 'Bearer realm="openmail"' },
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

  const mcp = createMailMcpServer({ store: options.store, imap: options.imap, userId: principal.userId });
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
