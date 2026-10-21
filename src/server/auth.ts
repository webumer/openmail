import { createHash, timingSafeEqual } from "node:crypto";

const DUMMY_HASH = createHash("sha256").update("openmail-unconfigured-key").digest();

/** SHA-256 digests of comma-separated API keys. Raw key material is not retained. */
export function hashApiKeys(raw: string | undefined): Buffer[] {
  if (!raw) return [];
  const hashes: Buffer[] = [];
  for (const part of raw.split(",")) {
    const key = part.trim();
    if (!key) continue;
    hashes.push(createHash("sha256").update(key, "utf8").digest());
  }
  return hashes;
}

export function readBearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  const token = match?.[1];
  if (!token) return null;
  return token;
}

/**
 * Compare the presented bearer token to configured key hashes.
 * Every configured digest is checked so the match position does not return early.
 */
export function matchApiKey(token: string, hashes: readonly Buffer[]): string | null {
  const digest = createHash("sha256").update(token, "utf8").digest();
  const candidates = hashes.length > 0 ? hashes : [DUMMY_HASH];
  let matched: Buffer | null = null;
  for (const candidate of candidates) {
    if (candidate.length !== digest.length) continue;
    if (timingSafeEqual(digest, candidate) && hashes.length > 0) matched = candidate;
  }
  return matched ? matched.toString("hex") : null;
}

export function authorizeRequest(
  authorizationHeader: string | undefined,
  hashes: readonly Buffer[],
): { ok: true; keyId: string } | { ok: false } {
  const token = readBearerToken(authorizationHeader);
  if (!token) return { ok: false };
  const keyId = matchApiKey(token, hashes);
  if (!keyId) return { ok: false };
  return { ok: true, keyId };
}
