/** Read tools. Issued on every grant. */
export const MAIL_READ_SCOPE = "mail.read";
/** Send tool. Granted only together with mail.read, and only when the user ticks the box. */
export const MAIL_SEND_SCOPE = "mail.send";
export const SUPPORTED_SCOPES: readonly string[] = [MAIL_READ_SCOPE, MAIL_SEND_SCOPE];

export const ACCESS_TOKEN_TTL_SECONDS = 60 * 60;
export const REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;
export const AUTHORIZATION_CODE_TTL_SECONDS = 5 * 60;

export interface OAuthConfig {
  /** Authorization server issuer, e.g. https://mcp.openmail.tools (no trailing slash). */
  issuer: string;
  /** Canonical MCP resource URI, e.g. https://mcp.openmail.tools/mcp. */
  resource: string;
  /** RFC 9728 metadata URL advertised in WWW-Authenticate. */
  resourceMetadataUrl: string;
  /** Allow http://localhost issuers in tests only. */
  allowInsecureIssuer?: boolean;
}

/**
 * Derives issuer and resource from OPENMAIL_PUBLIC_URL. Returns null when the
 * URL is missing or is not https (OAuth stays off in that case).
 */
export function deriveOAuthConfig(publicUrl: string | undefined, options: { allowHttp?: boolean } = {}): OAuthConfig | null {
  const raw = publicUrl?.trim();
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.username || url.password || url.search || url.hash) return null;
  if (url.protocol !== "https:" && !(options.allowHttp && url.protocol === "http:")) return null;
  const issuer = url.origin;
  const resource = `${issuer}/mcp`;
  return {
    issuer,
    resource,
    resourceMetadataUrl: `${issuer}/.well-known/oauth-protected-resource/mcp`,
    ...(options.allowHttp ? { allowInsecureIssuer: true } : {}),
  };
}

/**
 * RFC 8707 resource check. Accepts the canonical MCP URL and the server
 * origin (some clients send the origin), with case-insensitive scheme/host and
 * an optional trailing slash. Anything else is a different audience.
 */
export function isOurResource(config: OAuthConfig, value: string): boolean {
  if (value.length > 2000) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.username || url.password || url.search || url.hash) return false;
  if (value.includes("#")) return false;
  if (url.origin !== config.issuer) return false;
  const path = url.pathname.replace(/\/+$/, "");
  return path === "" || path === "/mcp";
}

/** Parses a space-delimited scope string. offline_access is accepted and ignored. */
export function parseScope(raw: string | undefined): { ok: true; scope: string } | { ok: false } {
  if (raw === undefined || raw.trim() === "") return { ok: true, scope: MAIL_READ_SCOPE };
  if (raw.length > 500) return { ok: false };
  const parts = raw.split(" ").filter((part) => part.length > 0);
  const granted = new Set<string>();
  for (const part of parts) {
    if (part === "offline_access") continue;
    if (!SUPPORTED_SCOPES.includes(part)) return { ok: false };
    granted.add(part);
  }
  if (granted.has(MAIL_SEND_SCOPE)) granted.add(MAIL_READ_SCOPE);
  if (granted.size === 0) granted.add(MAIL_READ_SCOPE);
  const ordered = SUPPORTED_SCOPES.filter((scope) => granted.has(scope));
  return { ok: true, scope: ordered.join(" ") };
}
