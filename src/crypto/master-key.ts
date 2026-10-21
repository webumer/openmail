import { randomBytes } from "node:crypto";
import { AES_KEY_BYTES } from "./envelope.js";

const INVALID = "OPENMAIL_MASTER_KEY is invalid: expected 32 bytes of standard base64";

/**
 * 32-byte key encoded as standard base64. Tests pass this into `loadMasterKey`.
 * Production startup never invents a key when the env var is missing.
 */
export function generateTestMasterKey(): string {
  return randomBytes(AES_KEY_BYTES).toString("base64");
}

export function loadMasterKey(raw: string | undefined): Buffer {
  if (raw === undefined || raw.trim() === "") {
    throw new Error("OPENMAIL_MASTER_KEY is not set");
  }
  const trimmed = raw.trim();
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(trimmed)) throw new Error(INVALID);
  const key = Buffer.from(trimmed, "base64");
  if (key.length !== AES_KEY_BYTES || key.toString("base64") !== trimmed) throw new Error(INVALID);
  return key;
}
