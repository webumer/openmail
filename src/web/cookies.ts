export const SESSION_COOKIE = "om_session";
export const CSRF_COOKIE = "om_csrf";
export const SESSION_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;
export const PRESESSION_CSRF_MAX_AGE_SECONDS = 2 * 60 * 60;

/**
 * Session cookies are Secure unless local HTTP development opts out.
 * That opt-out is refused when NODE_ENV is production.
 * @returns true when the cookie must include the Secure attribute.
 */
export function resolveSecureCookies(env: { OPENMAIL_INSECURE_COOKIES?: string; NODE_ENV?: string }): boolean {
  if (env.OPENMAIL_INSECURE_COOKIES !== "1") return true;
  if (env.NODE_ENV === "production") {
    throw new Error("OPENMAIL_INSECURE_COOKIES cannot be enabled when NODE_ENV is production");
  }
  return false;
}

export function serializeCookie(name: string, value: string, options: { maxAge: number; secure: boolean }): string {
  if (!/^[A-Za-z0-9_]+$/.test(name) || /[\r\n;]/.test(value)) throw new Error("Invalid cookie");
  const parts = [`${name}=${value}`, "Path=/", "HttpOnly", "SameSite=Lax"];
  if (options.secure) parts.push("Secure");
  parts.push(`Max-Age=${options.maxAge}`);
  return parts.join("; ");
}

export function clearCookie(name: string, secure: boolean): string {
  return serializeCookie(name, "", { maxAge: 0, secure });
}

export function readCookies(header: string | undefined): Map<string, string> {
  const cookies = new Map<string, string>();
  if (!header || header.length > 8192) return cookies;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    const name = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (!name || value.length > 500) continue;
    cookies.set(name, value);
  }
  return cookies;
}
