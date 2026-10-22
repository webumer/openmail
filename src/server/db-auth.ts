import type Database from "better-sqlite3";
import { apiKeys } from "../services/index.js";
import { resolveAccessToken } from "../oauth/grants.js";
import { ACCESS_TOKEN_PREFIX } from "../oauth/tokens.js";
import { readBearerToken } from "./auth.js";

/**
 * Bearer token → user. Two kinds of token map to the same user with the same
 * tenant isolation:
 * - OAuth access tokens (oma_…), checked for expiry, revocation, audience
 *   (`resource`) and the mail.read scope;
 * - API keys (om_…), SHA-256 → api_keys row that is not revoked.
 */
export function authenticateDatabaseKey(
  db: Database,
  authorizationHeader: string | undefined,
  oauthResource?: string,
): { userId: string; keyId: string } | null {
  const token = readBearerToken(authorizationHeader);
  if (!token) return null;
  if (token.startsWith(ACCESS_TOKEN_PREFIX)) {
    if (!oauthResource) return null;
    const grant = resolveAccessToken(db, token, oauthResource);
    return grant ? { userId: grant.userId, keyId: `oauth:${grant.grantId}` } : null;
  }
  return apiKeys.resolve(db, token);
}
