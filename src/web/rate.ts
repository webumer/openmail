import { SlidingWindowRateLimit } from "../server/rate-limit.js";

export const AUTH_ATTEMPT_LIMIT = 10;
export const AUTH_ATTEMPT_WINDOW_MS = 15 * 60 * 1000;

/** Both the client address and the email must be under the window. */
export function attemptAllowed(
  limiter: SlidingWindowRateLimit,
  scope: string,
  ip: string,
  email: string | undefined,
  now = Date.now(),
): boolean {
  const ipOk = limiter.allow(`${scope}:ip:${ip}`, now);
  const emailOk = email ? limiter.allow(`${scope}:email:${email}`, now) : true;
  return ipOk && emailOk;
}

export function rateLimitEmail(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const email = raw.trim().toLowerCase();
  if (!email || email.length > 320) return undefined;
  return email;
}
