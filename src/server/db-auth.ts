import type Database from "better-sqlite3";
import { MAIL_SEND_SCOPE } from "../oauth/config.js";
import { apiKeys } from "../services/index.js";
import { resolveAccessToken } from "../oauth/grants.js";
import { ACCESS_TOKEN_PREFIX } from "../oauth/tokens.js";
import { readBearerToken } from "./auth.js";

export interface Principal {
  userId: string;
  keyId: string;
  canSend: boolean;
  /** `oauth:<client name>` or `api_key:<key name>`. Stored in the send log. */
  via: string;
}

/**
 * Bearer token → user. Two kinds of token map to the same user with the same
 * tenant isolation:
 * - OAuth access tokens (oma_…), checked for expiry, revocation, audience
 *   (`resource`) and the mail.read scope. mail.send is optional;
 * - API keys (om_…), SHA-256 → api_keys row that is not revoked.
 */
export function authenticateDatabaseKey(
  db: Database,
  authorizationHeader: string | undefined,
  oauthResource?: string,
): Principal | null {
  const token = readBearerToken(authorizationHeader);
  if (!token) return null;
  if (token.startsWith(ACCESS_TOKEN_PREFIX)) {
    if (!oauthResource) return null;
    const grant = resolveAccessToken(db, token, oauthResource);
    if (!grant) return null;
    return {
      userId: grant.userId,
      keyId: `oauth:${grant.grantId}`,
      canSend: grant.scope.split(" ").includes(MAIL_SEND_SCOPE),
      via: `oauth:${oneLine(grant.clientName)}`,
    };
  }
  const key = apiKeys.resolve(db, token);
  if (!key) return null;
  return { userId: key.userId, keyId: key.keyId, canSend: key.canSend, via: `api_key:${oneLine(key.name)}` };
}

function oneLine(value: string): string {
  const clean = value.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  return clean.slice(0, 200) || "unknown";
}
