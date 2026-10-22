/**
 * Where to go after logging in. Only the OAuth authorize endpoint on this
 * site is allowed, so `next` can never become an open redirect.
 */
export const MAX_NEXT_LENGTH = 4096;

export function safeNext(raw: string | null | undefined): string | undefined {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > MAX_NEXT_LENGTH) return undefined;
  if (!raw.startsWith("/oauth/authorize?")) return undefined;
  if (/[\r\n\t\\]/.test(raw) || raw.startsWith("//")) return undefined;
  let url: URL;
  try {
    url = new URL(raw, "https://openmail.invalid");
  } catch {
    return undefined;
  }
  if (url.origin !== "https://openmail.invalid" || url.pathname !== "/oauth/authorize") return undefined;
  return `${url.pathname}${url.search}`;
}
