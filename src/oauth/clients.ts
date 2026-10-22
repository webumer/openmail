import type Database from "better-sqlite3";
import { CimdFetchError, type DocumentFetcher } from "./cimd-fetch.js";
import { parseRedirectUri } from "./redirect-uri.js";
import { CLIENT_ID_PREFIX, CLIENT_SECRET_PREFIX, randomToken, safeEqualHex, sha256Hex } from "./tokens.js";

export type ClientKind = "dcr" | "cimd";
export type TokenAuthMethod = "none" | "client_secret_post" | "client_secret_basic";

export interface OAuthClient {
  id: string;
  kind: ClientKind;
  clientName: string;
  clientUri: string | null;
  redirectUris: string[];
  tokenEndpointAuthMethod: TokenAuthMethod;
  hasSecret: boolean;
}

export class OAuthError extends Error {
  constructor(
    readonly code: string,
    readonly description: string,
    readonly status = 400,
  ) {
    super(description);
  }
}

/** Registered (DCR) clients kept in total. Unused ones are pruned first. */
export const MAX_DCR_CLIENTS = 5_000;
/** DCR clients with no grant are deleted after this long. */
export const UNUSED_DCR_CLIENT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const MAX_REDIRECT_URIS = 10;
export const MAX_CLIENT_NAME = 100;
export const CIMD_MIN_CACHE_SECONDS = 5 * 60;
/** no-store / max-age=0 documents are kept only this long (fetch-rate protection). */
export const CIMD_NO_STORE_CACHE_SECONDS = 60;
export const CIMD_MAX_CACHE_SECONDS = 60 * 60;
export const CIMD_DEFAULT_CACHE_SECONDS = 15 * 60;

interface ClientRow {
  id: string;
  kind: ClientKind;
  client_name: string;
  client_uri: string | null;
  redirect_uris: string;
  token_endpoint_auth_method: TokenAuthMethod;
  secret_hash: string | null;
  cache_expires_at: string | null;
}

function toClient(row: ClientRow): OAuthClient {
  return {
    id: row.id,
    kind: row.kind,
    clientName: row.client_name,
    clientUri: row.client_uri,
    redirectUris: JSON.parse(row.redirect_uris) as string[],
    tokenEndpointAuthMethod: row.token_endpoint_auth_method,
    hasSecret: row.secret_hash !== null,
  };
}

/** Control characters and bidi overrides are stripped from display names. */
export function cleanClientName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const cleaned = raw
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (cleaned.length === 0) return null;
  return cleaned.slice(0, MAX_CLIENT_NAME);
}

function parseRedirectList(raw: unknown): string[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new OAuthError("invalid_redirect_uri", "redirect_uris must be a non-empty array");
  }
  if (raw.length > MAX_REDIRECT_URIS) {
    throw new OAuthError("invalid_redirect_uri", `At most ${MAX_REDIRECT_URIS} redirect_uris are allowed`);
  }
  const out: string[] = [];
  for (const value of raw) {
    if (!parseRedirectUri(value)) {
      throw new OAuthError(
        "invalid_redirect_uri",
        "Each redirect URI must be https, or http on localhost/127.0.0.1/[::1], with no fragment",
      );
    }
    if (!out.includes(value as string)) out.push(value as string);
  }
  return out;
}

function optionalHttpsUri(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length > 500) return null;
  try {
    const url = new URL(raw);
    return url.protocol === "https:" && !url.username && !url.password ? url.toString() : null;
  } catch {
    return null;
  }
}

export interface RegisteredClient {
  client: OAuthClient;
  clientSecret?: string;
  issuedAt: number;
  grantTypes: string[];
  responseTypes: string[];
}

/** RFC 7591 registration. Only authorization_code + refresh_token clients. */
export function registerClient(db: Database, body: unknown, now = Date.now()): RegisteredClient {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new OAuthError("invalid_client_metadata", "Registration body must be a JSON object");
  }
  const meta = body as Record<string, unknown>;
  const redirectUris = parseRedirectList(meta.redirect_uris);
  const method = (meta.token_endpoint_auth_method ?? "none") as unknown;
  if (method !== "none" && method !== "client_secret_post" && method !== "client_secret_basic") {
    throw new OAuthError(
      "invalid_client_metadata",
      "token_endpoint_auth_method must be none, client_secret_post or client_secret_basic",
    );
  }
  const grantTypes = meta.grant_types === undefined ? ["authorization_code", "refresh_token"] : meta.grant_types;
  if (
    !Array.isArray(grantTypes) ||
    grantTypes.length === 0 ||
    !grantTypes.every((g) => g === "authorization_code" || g === "refresh_token") ||
    !grantTypes.includes("authorization_code")
  ) {
    throw new OAuthError("invalid_client_metadata", "grant_types must include authorization_code and may include refresh_token");
  }
  const responseTypes = meta.response_types === undefined ? ["code"] : meta.response_types;
  if (!Array.isArray(responseTypes) || responseTypes.length !== 1 || responseTypes[0] !== "code") {
    throw new OAuthError("invalid_client_metadata", "response_types must be [\"code\"]");
  }
  const clientName = cleanClientName(meta.client_name) ?? "Unnamed app";
  const clientUri = optionalHttpsUri(meta.client_uri);

  pruneDcrClients(db, now);
  let count = db.prepare("SELECT COUNT(*) AS n FROM oauth_clients WHERE kind = 'dcr'").get() as { n: number };
  if (count.n >= MAX_DCR_CLIENTS) {
    // Full: drop the oldest registrations that never got a grant (older than
    // 10 minutes, so flows in progress survive), then check again.
    db.prepare(
      `DELETE FROM oauth_clients WHERE id IN (
         SELECT c.id FROM oauth_clients c WHERE c.kind = 'dcr' AND c.created_at < ?
           AND NOT EXISTS (SELECT 1 FROM oauth_grants g WHERE g.client_id = c.id)
         ORDER BY c.created_at LIMIT 100)`,
    ).run(new Date(now - 10 * 60 * 1000).toISOString());
    count = db.prepare("SELECT COUNT(*) AS n FROM oauth_clients WHERE kind = 'dcr'").get() as { n: number };
  }
  if (count.n >= MAX_DCR_CLIENTS) {
    throw new OAuthError("temporarily_unavailable", "Client registration is temporarily unavailable", 503);
  }

  const id = randomToken(CLIENT_ID_PREFIX, 16);
  const secret = method === "none" ? undefined : randomToken(CLIENT_SECRET_PREFIX, 32);
  const stamp = new Date(now).toISOString();
  db.prepare(
    `INSERT INTO oauth_clients (id, kind, client_name, client_uri, redirect_uris, token_endpoint_auth_method, secret_hash, created_at, refreshed_at, cache_expires_at, last_used_at)
     VALUES (?, 'dcr', ?, ?, ?, ?, ?, ?, ?, NULL, NULL)`,
  ).run(id, clientName, clientUri, JSON.stringify(redirectUris), method, secret ? sha256Hex(secret) : null, stamp, stamp);
  const client: OAuthClient = {
    id,
    kind: "dcr",
    clientName,
    clientUri,
    redirectUris,
    tokenEndpointAuthMethod: method,
    hasSecret: secret !== undefined,
  };
  return {
    client,
    ...(secret ? { clientSecret: secret } : {}),
    issuedAt: Math.floor(now / 1000),
    grantTypes: grantTypes as string[],
    responseTypes: ["code"],
  };
}

/** Deletes DCR clients that never got a grant and are older than the TTL. */
export function pruneDcrClients(db: Database, now = Date.now()): void {
  const cutoff = new Date(now - UNUSED_DCR_CLIENT_TTL_MS).toISOString();
  db.prepare(
    `DELETE FROM oauth_clients WHERE kind = 'dcr' AND created_at < ?
     AND NOT EXISTS (SELECT 1 FROM oauth_grants g WHERE g.client_id = oauth_clients.id AND g.revoked_at IS NULL)`,
  ).run(cutoff);
}

/**
 * Deletes cached CIMD clients whose cache has expired and that have no live
 * grant, so arbitrary metadata URLs cannot grow the table without bound.
 * They are fetched again the next time they are used.
 */
export function pruneCimdClients(db: Database, now = Date.now()): void {
  db.prepare(
    `DELETE FROM oauth_clients WHERE kind = 'cimd' AND cache_expires_at < ?
     AND NOT EXISTS (SELECT 1 FROM oauth_grants g WHERE g.client_id = oauth_clients.id AND g.revoked_at IS NULL)`,
  ).run(new Date(now).toISOString());
}

export function getStoredClient(db: Database, clientId: string): OAuthClient | null {
  if (typeof clientId !== "string" || clientId.length === 0 || clientId.length > 1000) return null;
  const row = db
    .prepare(
      `SELECT id, kind, client_name, client_uri, redirect_uris, token_endpoint_auth_method, secret_hash, cache_expires_at
       FROM oauth_clients WHERE id = ?`,
    )
    .get(clientId) as ClientRow | undefined;
  return row ? toClient(row) : null;
}

/** Client secret check for confidential DCR clients. */
export function verifyClientSecret(db: Database, clientId: string, secret: string): boolean {
  const row = db.prepare("SELECT secret_hash FROM oauth_clients WHERE id = ?").get(clientId) as
    | { secret_hash: string | null }
    | undefined;
  const expected = row?.secret_hash ?? sha256Hex("openmail-no-client-secret");
  const ok = safeEqualHex(sha256Hex(secret), expected);
  return ok && row?.secret_hash !== null && row !== undefined;
}

/** A client_id that is an https URL with a path is a Client ID Metadata Document URL. */
export function isCimdClientId(clientId: string): boolean {
  return clientId.startsWith("https://");
}

export function parseCimdUrl(clientId: string): URL | null {
  if (clientId.length > 1000 || /[\s\\#]/.test(clientId)) return null;
  let url: URL;
  try {
    url = new URL(clientId);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) return null;
  if (url.port !== "" && url.port !== "443") return null;
  if (url.pathname === "/" || url.pathname === "") return null;
  if (url.toString() !== clientId) return null;
  const segments = clientId.slice(url.origin.length).split("/");
  if (segments.some((segment) => segment === "." || segment === ".." || /^%2e/i.test(segment))) return null;
  return url;
}

/**
 * Resolves a CIMD client: cached copy if still fresh, otherwise fetch,
 * validate (client_id must equal the URL exactly, redirect_uris required,
 * public client using "none"), and cache within 5 min to 1 h.
 */
export async function resolveCimdClient(
  db: Database,
  clientId: string,
  fetcher: DocumentFetcher,
  now = Date.now(),
  options: { forceRefresh?: boolean } = {},
): Promise<OAuthClient> {
  const url = parseCimdUrl(clientId);
  if (!url) throw new OAuthError("invalid_client", "client_id is not a valid client metadata document URL");
  const cached = db
    .prepare(
      `SELECT id, kind, client_name, client_uri, redirect_uris, token_endpoint_auth_method, secret_hash, cache_expires_at
       FROM oauth_clients WHERE id = ? AND kind = 'cimd'`,
    )
    .get(clientId) as ClientRow | undefined;
  if (!options.forceRefresh && cached?.cache_expires_at && Date.parse(cached.cache_expires_at) > now) return toClient(cached);

  let fetched;
  try {
    fetched = await fetcher(url);
  } catch (err) {
    // One message for every network failure, so the endpoint cannot be used
    // to learn how the server's resolver sees internal names. The rate-limit
    // message is the only exception (it reveals nothing about the target).
    const limited = err instanceof CimdFetchError && err.message.startsWith("too many");
    throw new OAuthError("invalid_client", limited ? err.message : "client metadata document could not be fetched");
  }
  if (fetched.status !== 200) throw new OAuthError("invalid_client", "client metadata document did not return 200");
  let doc: unknown;
  try {
    doc = JSON.parse(fetched.body);
  } catch {
    throw new OAuthError("invalid_client", "client metadata document is not valid JSON");
  }
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) {
    throw new OAuthError("invalid_client", "client metadata document must be a JSON object");
  }
  const meta = doc as Record<string, unknown>;
  if (meta.client_id !== clientId) {
    throw new OAuthError("invalid_client", "client_id in the metadata document does not match its URL");
  }
  if (meta.client_secret !== undefined || meta.client_secret_expires_at !== undefined) {
    throw new OAuthError("invalid_client", "client metadata document must not contain a client secret");
  }
  let redirectUris: string[];
  try {
    redirectUris = parseRedirectList(meta.redirect_uris);
  } catch (err) {
    throw new OAuthError("invalid_client", err instanceof OAuthError ? err.description : "invalid redirect_uris");
  }
  const single = meta.token_endpoint_auth_method;
  const plural = meta.token_endpoint_auth_methods_supported;
  const supportsNone =
    single === undefined && plural === undefined
      ? true
      : single === "none" || (Array.isArray(plural) && plural.includes("none"));
  if (!supportsNone) {
    throw new OAuthError("invalid_client", "OpenMail supports only public clients (token_endpoint_auth_method none)");
  }
  if (meta.grant_types !== undefined) {
    if (!Array.isArray(meta.grant_types) || !meta.grant_types.includes("authorization_code")) {
      throw new OAuthError("invalid_client", "client metadata grant_types must include authorization_code");
    }
  }
  const clientName = cleanClientName(meta.client_name) ?? url.hostname;
  const clientUri = optionalHttpsUri(meta.client_uri);
  const ttl = fetched.noStore || fetched.maxAge === 0
    ? CIMD_NO_STORE_CACHE_SECONDS
    : Math.min(CIMD_MAX_CACHE_SECONDS, Math.max(CIMD_MIN_CACHE_SECONDS, fetched.maxAge ?? CIMD_DEFAULT_CACHE_SECONDS));
  const stamp = new Date(now).toISOString();
  const expires = new Date(now + ttl * 1000).toISOString();
  if (!cached) pruneCimdClients(db, now);
  db.prepare(
    `INSERT INTO oauth_clients (id, kind, client_name, client_uri, redirect_uris, token_endpoint_auth_method, secret_hash, created_at, refreshed_at, cache_expires_at, last_used_at)
     VALUES (?, 'cimd', ?, ?, ?, 'none', NULL, ?, ?, ?, NULL)
     ON CONFLICT(id) DO UPDATE SET client_name = excluded.client_name, client_uri = excluded.client_uri,
       redirect_uris = excluded.redirect_uris, refreshed_at = excluded.refreshed_at, cache_expires_at = excluded.cache_expires_at`,
  ).run(clientId, clientName, clientUri, JSON.stringify(redirectUris), stamp, stamp, expires);
  return {
    id: clientId,
    kind: "cimd",
    clientName,
    clientUri,
    redirectUris,
    tokenEndpointAuthMethod: "none",
    hasSecret: false,
  };
}
