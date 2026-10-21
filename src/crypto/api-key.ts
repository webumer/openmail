import { createHash, randomBytes } from "node:crypto";

/** First characters of the full key stored for display. The rest is never stored. */
export const API_KEY_PREFIX_LENGTH = 12;

/** 30 bytes is 40 base64url characters with no padding. */
const API_KEY_RANDOM_BYTES = 30;

export interface GeneratedApiKey {
  token: string;
  prefix: string;
  keyHash: string;
}

export function generateApiKey(): GeneratedApiKey {
  const random = randomBytes(API_KEY_RANDOM_BYTES).toString("base64url");
  if (random.length !== 40) throw new Error("API key generation failed");
  const token = `om_${random}`;
  return {
    token,
    prefix: token.slice(0, API_KEY_PREFIX_LENGTH),
    keyHash: hashApiKey(token),
  };
}

/** SHA-256 hex digest of the full bearer token. */
export function hashApiKey(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}
