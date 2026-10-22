import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import {
  ACCESS_TOKEN_TTL_SECONDS,
  AUTHORIZATION_CODE_TTL_SECONDS,
  MAIL_READ_SCOPE,
  REFRESH_TOKEN_TTL_SECONDS,
} from "./config.js";
import { OAuthError, type OAuthClient } from "./clients.js";
import { redirectHost } from "./redirect-uri.js";
import { ACCESS_TOKEN_PREFIX, CODE_PREFIX, REFRESH_TOKEN_PREFIX, randomToken, sha256Hex, verifyPkce } from "./tokens.js";

// One description per grant type so failures do not reveal why a code or
// token was refused.
const CODE_INVALID = "Authorization code is invalid, expired or already used";
const REFRESH_INVALID = "Refresh token is invalid, expired or revoked";

const GRANT_TOUCH_INTERVAL_MS = 60_000;

export interface IssuedTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  scope: string;
  grantId: string;
}

export interface GrantSummary {
  id: string;
  clientName: string;
  clientKind: "dcr" | "cimd";
  clientHost: string;
  redirectHost: string;
  scope: string;
  createdAt: string;
  lastUsedAt: string | null;
}

/** Called after the user clicks Allow. Returns the raw code (shown once, in the redirect). */
export function createAuthorizationCode(
  db: Database,
  input: {
    client: OAuthClient;
    userId: string;
    redirectUri: string;
    codeChallenge: string;
    scope: string;
    resource: string;
  },
  now = Date.now(),
): string {
  purgeExpired(db, now);
  const code = randomToken(CODE_PREFIX, 32);
  db.prepare(
    `INSERT INTO oauth_codes (code_hash, client_id, user_id, redirect_uri, code_challenge, scope, resource, created_at, expires_at, used_at, grant_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)`,
  ).run(
    sha256Hex(code),
    input.client.id,
    input.userId,
    input.redirectUri,
    input.codeChallenge,
    input.scope,
    input.resource,
    new Date(now).toISOString(),
    new Date(now + AUTHORIZATION_CODE_TTL_SECONDS * 1000).toISOString(),
  );
  return code;
}

interface CodeRow {
  code_hash: string;
  client_id: string;
  user_id: string;
  redirect_uri: string;
  code_challenge: string;
  scope: string;
  resource: string;
  expires_at: string;
  used_at: string | null;
  grant_id: string | null;
}

/**
 * Authorization code exchange. A code works once; a second attempt revokes
 * every token issued from it (RFC 6749 section 4.1.2 / OAuth 2.1).
 */
export function redeemAuthorizationCode(
  db: Database,
  input: { client: OAuthClient; code: string; redirectUri: string | undefined; codeVerifier: string | undefined; resource: string | undefined },
  now = Date.now(),
): IssuedTokens {
  const run = db.transaction((): IssuedTokens | OAuthError => {
    const row = db.prepare("SELECT * FROM oauth_codes WHERE code_hash = ?").get(sha256Hex(input.code)) as
      | CodeRow
      | undefined;
    if (!row) return new OAuthError("invalid_grant", CODE_INVALID);
    if (row.used_at) {
      if (row.grant_id) revokeGrantById(db, row.grant_id, now);
      return new OAuthError("invalid_grant", CODE_INVALID);
    }
    if (Date.parse(row.expires_at) <= now) return new OAuthError("invalid_grant", CODE_INVALID);
    if (row.client_id !== input.client.id) return new OAuthError("invalid_grant", CODE_INVALID);
    if (input.redirectUri === undefined || input.redirectUri !== row.redirect_uri) {
      return new OAuthError("invalid_grant", CODE_INVALID);
    }
    if (!input.codeVerifier || !verifyPkce(input.codeVerifier, row.code_challenge)) {
      return new OAuthError("invalid_grant", CODE_INVALID);
    }
    if (input.resource !== undefined && input.resource !== row.resource) {
      return new OAuthError("invalid_target", "resource does not match the authorization request");
    }
    const grantId = randomUUID();
    const stamp = new Date(now).toISOString();
    db.prepare(
      `INSERT INTO oauth_grants (id, user_id, client_id, client_kind, client_name, redirect_host, scope, resource, created_at, last_used_at, revoked_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)`,
    ).run(
      grantId,
      row.user_id,
      input.client.id,
      input.client.kind,
      input.client.clientName,
      redirectHost(row.redirect_uri),
      row.scope,
      row.resource,
      stamp,
    );
    const claimed = db
      .prepare("UPDATE oauth_codes SET used_at = ?, grant_id = ? WHERE code_hash = ? AND used_at IS NULL")
      .run(stamp, grantId, row.code_hash);
    if (claimed.changes !== 1) return new OAuthError("invalid_grant", CODE_INVALID);
    db.prepare("UPDATE oauth_clients SET last_used_at = ? WHERE id = ?").run(stamp, input.client.id);
    return issueTokens(db, grantId, row.scope, now);
  });
  const result = run();
  if (result instanceof OAuthError) throw result;
  return result;
}

interface RefreshRow {
  token_hash: string;
  grant_id: string;
  expires_at: string;
  rotated_at: string | null;
  revoked_at: string | null;
  client_id: string;
  scope: string;
  resource: string;
  grant_revoked: string | null;
}

/**
 * Refresh with rotation. Each refresh token works once. Presenting a rotated
 * one again is treated as theft: the whole grant is revoked.
 */
export function refreshGrant(
  db: Database,
  input: { client: OAuthClient; refreshToken: string; scope: string | undefined; resource: string | undefined },
  now = Date.now(),
): IssuedTokens {
  const run = db.transaction((): IssuedTokens | OAuthError => {
    const row = db
      .prepare(
        `SELECT t.token_hash, t.grant_id, t.expires_at, t.rotated_at, t.revoked_at,
                g.client_id, g.scope, g.resource, g.revoked_at AS grant_revoked
         FROM oauth_tokens t JOIN oauth_grants g ON g.id = t.grant_id
         WHERE t.token_hash = ? AND t.kind = 'refresh'`,
      )
      .get(sha256Hex(input.refreshToken)) as RefreshRow | undefined;
    if (!row) return new OAuthError("invalid_grant", REFRESH_INVALID);
    if (row.client_id !== input.client.id) return new OAuthError("invalid_grant", REFRESH_INVALID);
    if (row.grant_revoked || row.revoked_at) return new OAuthError("invalid_grant", REFRESH_INVALID);
    if (row.rotated_at) {
      revokeGrantById(db, row.grant_id, now);
      return new OAuthError("invalid_grant", REFRESH_INVALID);
    }
    if (Date.parse(row.expires_at) <= now) return new OAuthError("invalid_grant", REFRESH_INVALID);
    if (input.resource !== undefined && input.resource !== row.resource) {
      return new OAuthError("invalid_target", "resource does not match the original grant");
    }
    let scope = row.scope;
    if (input.scope !== undefined) {
      const granted = new Set(row.scope.split(" "));
      const requested = input.scope.split(" ").filter(Boolean);
      if (!requested.every((s) => granted.has(s))) return new OAuthError("invalid_scope", "Requested scope exceeds the grant");
      scope = requested.join(" ");
    }
    const stamp = new Date(now).toISOString();
    const rotated = db
      .prepare("UPDATE oauth_tokens SET rotated_at = ? WHERE token_hash = ? AND rotated_at IS NULL")
      .run(stamp, row.token_hash);
    if (rotated.changes !== 1) {
      revokeGrantById(db, row.grant_id, now);
      return new OAuthError("invalid_grant", REFRESH_INVALID);
    }
    return issueTokens(db, row.grant_id, scope, now);
  });
  const result = run();
  if (result instanceof OAuthError) throw result;
  return result;
}

function issueTokens(db: Database, grantId: string, scope: string, now: number): IssuedTokens {
  const accessToken = randomToken(ACCESS_TOKEN_PREFIX, 32);
  const refreshToken = randomToken(REFRESH_TOKEN_PREFIX, 32);
  const stamp = new Date(now).toISOString();
  // A grant has one live access token: rotating retires the previous one, so a
  // copied access token stops working as soon as the real client refreshes.
  db.prepare(
    `UPDATE oauth_tokens SET revoked_at = ? WHERE grant_id = ? AND kind = 'access' AND revoked_at IS NULL`,
  ).run(stamp, grantId);
  const insert = db.prepare(
    `INSERT INTO oauth_tokens (token_hash, grant_id, kind, created_at, expires_at, rotated_at, revoked_at)
     VALUES (?, ?, ?, ?, ?, NULL, NULL)`,
  );
  insert.run(sha256Hex(accessToken), grantId, "access", stamp, new Date(now + ACCESS_TOKEN_TTL_SECONDS * 1000).toISOString());
  insert.run(sha256Hex(refreshToken), grantId, "refresh", stamp, new Date(now + REFRESH_TOKEN_TTL_SECONDS * 1000).toISOString());
  return { accessToken, refreshToken, expiresIn: ACCESS_TOKEN_TTL_SECONDS, scope, grantId };
}

/** Bearer access token → user, for /mcp. Checks expiry, revocation, audience and scope. */
export function resolveAccessToken(
  db: Database,
  token: string,
  resource: string,
  now = Date.now(),
): { userId: string; grantId: string; scope: string; clientName: string } | null {
  if (!token.startsWith(ACCESS_TOKEN_PREFIX) || token.length > 200) return null;
  const row = db
    .prepare(
      `SELECT t.expires_at, t.revoked_at, g.id AS grant_id, g.user_id, g.scope, g.resource, g.client_name, g.revoked_at AS grant_revoked, g.last_used_at
       FROM oauth_tokens t JOIN oauth_grants g ON g.id = t.grant_id
       WHERE t.token_hash = ? AND t.kind = 'access'`,
    )
    .get(sha256Hex(token)) as
    | {
        expires_at: string;
        revoked_at: string | null;
        grant_id: string;
        user_id: string;
        scope: string;
        client_name: string;
        resource: string;
        grant_revoked: string | null;
        last_used_at: string | null;
      }
    | undefined;
  if (!row || row.revoked_at || row.grant_revoked) return null;
  if (Date.parse(row.expires_at) <= now) return null;
  if (row.resource !== resource) return null;
  if (!row.scope.split(" ").includes(MAIL_READ_SCOPE)) return null;
  if (!row.last_used_at || now - Date.parse(row.last_used_at) >= GRANT_TOUCH_INTERVAL_MS) {
    db.prepare("UPDATE oauth_grants SET last_used_at = ? WHERE id = ?").run(new Date(now).toISOString(), row.grant_id);
  }
  return { userId: row.user_id, grantId: row.grant_id, scope: row.scope, clientName: row.client_name };
}

/**
 * RFC 7009. Revoking a refresh token revokes the whole grant; revoking an
 * access token revokes only that token. Tokens of other clients are ignored.
 */
export function revokeToken(db: Database, input: { client: OAuthClient; token: string }, now = Date.now()): void {
  if (input.token.length === 0 || input.token.length > 500) return;
  const row = db
    .prepare(
      `SELECT t.token_hash, t.kind, t.grant_id, g.client_id FROM oauth_tokens t JOIN oauth_grants g ON g.id = t.grant_id
       WHERE t.token_hash = ?`,
    )
    .get(sha256Hex(input.token)) as { token_hash: string; kind: string; grant_id: string; client_id: string } | undefined;
  if (!row || row.client_id !== input.client.id) return;
  if (row.kind === "refresh") {
    revokeGrantById(db, row.grant_id, now);
    return;
  }
  db.prepare("UPDATE oauth_tokens SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL").run(
    new Date(now).toISOString(),
    row.token_hash,
  );
}

function revokeGrantById(db: Database, grantId: string, now: number): void {
  const stamp = new Date(now).toISOString();
  db.prepare("UPDATE oauth_grants SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL").run(stamp, grantId);
  db.prepare("UPDATE oauth_tokens SET revoked_at = ? WHERE grant_id = ? AND revoked_at IS NULL").run(stamp, grantId);
}

/** Dashboard "Disconnect". Only the owner can revoke. */
export function revokeGrantForUser(db: Database, userId: string, grantId: string, now = Date.now()): boolean {
  const row = db.prepare("SELECT id FROM oauth_grants WHERE id = ? AND user_id = ? AND revoked_at IS NULL").get(grantId, userId);
  if (!row) return false;
  revokeGrantById(db, grantId, now);
  return true;
}

/** Active connections for the dashboard. */
export function listGrants(db: Database, userId: string, now = Date.now()): GrantSummary[] {
  const rows = db
    .prepare(
      `SELECT g.id, g.client_id, g.client_name, g.client_kind, g.redirect_host, g.scope, g.created_at, g.last_used_at
       FROM oauth_grants g
       WHERE g.user_id = ? AND g.revoked_at IS NULL
         AND EXISTS (SELECT 1 FROM oauth_tokens t WHERE t.grant_id = g.id AND t.kind = 'refresh'
                     AND t.revoked_at IS NULL AND t.rotated_at IS NULL AND t.expires_at > ?)
       ORDER BY g.created_at DESC, g.id`,
    )
    .all(userId, new Date(now).toISOString()) as Array<{
    id: string;
    client_id: string;
    client_name: string;
    client_kind: "dcr" | "cimd";
    redirect_host: string;
    scope: string;
    created_at: string;
    last_used_at: string | null;
  }>;
  return rows.map((row) => ({
    id: row.id,
    clientName: row.client_name,
    clientKind: row.client_kind,
    clientHost: clientHost(row.client_id, row.client_kind),
    redirectHost: row.redirect_host,
    scope: row.scope,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
  }));
}

function clientHost(clientId: string, kind: "dcr" | "cimd"): string {
  if (kind !== "cimd") return "";
  try {
    return new URL(clientId).hostname;
  } catch {
    return "";
  }
}

/** Expired codes and tokens are useless; delete them so tables stay small. */
export function purgeExpired(db: Database, now = Date.now()): void {
  const cutoff = new Date(now - 24 * 60 * 60 * 1000).toISOString();
  db.prepare("DELETE FROM oauth_codes WHERE expires_at < ?").run(cutoff);
  db.prepare("DELETE FROM oauth_tokens WHERE expires_at < ?").run(cutoff);
}
