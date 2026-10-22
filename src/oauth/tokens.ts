import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/** Opaque, prefixed random values. Only their SHA-256 hashes are stored. */
export const ACCESS_TOKEN_PREFIX = "oma_";
export const REFRESH_TOKEN_PREFIX = "omr_";
export const CODE_PREFIX = "omc_";
export const CLIENT_ID_PREFIX = "omcl_";
export const CLIENT_SECRET_PREFIX = "oms_";

export function randomToken(prefix: string, bytes = 32): string {
  return `${prefix}${randomBytes(bytes).toString("base64url")}`;
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function safeEqualHex(a: string, b: string): boolean {
  const left = Buffer.from(a, "hex");
  const right = Buffer.from(b, "hex");
  if (left.length !== right.length || left.length === 0) return false;
  return timingSafeEqual(left, right);
}

/** RFC 7636 code_verifier: 43-128 unreserved characters. */
export function isValidCodeVerifier(value: string): boolean {
  return /^[A-Za-z0-9\-._~]{43,128}$/.test(value);
}

/** S256 code_challenge: base64url SHA-256, always 43 characters. */
export function isValidCodeChallenge(value: string): boolean {
  return /^[A-Za-z0-9\-_]{43}$/.test(value);
}

export function s256(verifier: string): string {
  return createHash("sha256").update(verifier, "ascii").digest("base64url");
}

export function verifyPkce(verifier: string, challenge: string): boolean {
  if (!isValidCodeVerifier(verifier) || !isValidCodeChallenge(challenge)) return false;
  const computed = Buffer.from(s256(verifier));
  const expected = Buffer.from(challenge);
  return computed.length === expected.length && timingSafeEqual(computed, expected);
}
