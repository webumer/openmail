/**
 * Redirect URI rules. Registered URIs must be https, or http on a loopback
 * host (RFC 8252 native apps such as Claude Code and MCP Inspector). No
 * fragments, no userinfo, no custom schemes. Matching is exact string
 * comparison, except that a loopback redirect may use any port (RFC 8252
 * section 7.3); scheme, host, path and query must still match exactly.
 */
export const MAX_REDIRECT_URI_LENGTH = 2000;

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

export function parseRedirectUri(raw: unknown): URL | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > MAX_REDIRECT_URI_LENGTH) return null;
  if (raw.includes("#") || /[\s\\<>"`]/.test(raw)) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.username || url.password) return null;
  if (url.protocol === "https:") {
    if (!url.hostname) return null;
    return url;
  }
  if (url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname)) return url;
  return null;
}

export function isLoopbackRedirect(url: URL): boolean {
  return url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname);
}

/** True when `presented` is allowed by one of the registered redirect URIs. */
export function redirectUriAllowed(registered: readonly string[], presented: string): boolean {
  const url = parseRedirectUri(presented);
  if (!url) return false;
  if (registered.includes(presented)) return true;
  if (!isLoopbackRedirect(url)) return false;
  for (const candidate of registered) {
    const reg = parseRedirectUri(candidate);
    if (!reg || !isLoopbackRedirect(reg)) continue;
    if (reg.hostname === url.hostname && reg.pathname === url.pathname && reg.search === url.search) return true;
  }
  return false;
}

/** Host to show on the consent screen, e.g. "claude.ai" or "localhost". */
export function redirectHost(raw: string): string {
  const url = parseRedirectUri(raw);
  return url ? url.hostname : "unknown";
}
