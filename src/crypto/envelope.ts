import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export const AES_KEY_BYTES = 32;
export const GCM_IV_BYTES = 12;
export const GCM_TAG_BYTES = 16;

export interface SealedSecret {
  iv: Buffer;
  tag: Buffer;
  ciphertext: Buffer;
}

export function generateDataKey(): Buffer {
  return randomBytes(AES_KEY_BYTES);
}

/** AES-256-GCM wrap. Layout is iv (12) | tag (16) | ciphertext. AAD is `user:<userId>`. */
export function wrapDataKey(masterKey: Buffer, userId: string, dataKey: Buffer): Buffer {
  assertAesKey(masterKey);
  assertAesKey(dataKey);
  assertLabel(userId, "userId");
  const iv = randomBytes(GCM_IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", masterKey, iv, { authTagLength: GCM_TAG_BYTES });
  cipher.setAAD(userAad(userId));
  const ciphertext = Buffer.concat([cipher.update(dataKey), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ciphertext]);
}

export function unwrapDataKey(masterKey: Buffer, userId: string, wrapped: Buffer): Buffer {
  assertAesKey(masterKey);
  assertLabel(userId, "userId");
  if (wrapped.length !== GCM_IV_BYTES + GCM_TAG_BYTES + AES_KEY_BYTES) {
    throw new Error("Decryption failed");
  }
  const iv = wrapped.subarray(0, GCM_IV_BYTES);
  const tag = wrapped.subarray(GCM_IV_BYTES, GCM_IV_BYTES + GCM_TAG_BYTES);
  const ciphertext = wrapped.subarray(GCM_IV_BYTES + GCM_TAG_BYTES);
  try {
    const decipher = createDecipheriv("aes-256-gcm", masterKey, iv, { authTagLength: GCM_TAG_BYTES });
    decipher.setAAD(userAad(userId));
    decipher.setAuthTag(tag);
    const dataKey = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    if (dataKey.length !== AES_KEY_BYTES) throw new Error("Decryption failed");
    return dataKey;
  } catch (err) {
    throw decryptionFailed(err);
  }
}

/** AES-256-GCM with a fresh 12-byte IV. AAD is `account:<accountId>`. */
export function sealPassword(dataKey: Buffer, accountId: string, password: string): SealedSecret {
  assertAesKey(dataKey);
  assertLabel(accountId, "accountId");
  const iv = randomBytes(GCM_IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", dataKey, iv, { authTagLength: GCM_TAG_BYTES });
  cipher.setAAD(accountAad(accountId));
  const ciphertext = Buffer.concat([cipher.update(password, "utf8"), cipher.final()]);
  return { iv, tag: cipher.getAuthTag(), ciphertext };
}

export function openPassword(dataKey: Buffer, accountId: string, sealed: SealedSecret): string {
  assertAesKey(dataKey);
  assertLabel(accountId, "accountId");
  if (sealed.iv.length !== GCM_IV_BYTES || sealed.tag.length !== GCM_TAG_BYTES) {
    throw new Error("Decryption failed");
  }
  try {
    const decipher = createDecipheriv("aes-256-gcm", dataKey, sealed.iv, { authTagLength: GCM_TAG_BYTES });
    decipher.setAAD(accountAad(accountId));
    decipher.setAuthTag(sealed.tag);
    return Buffer.concat([decipher.update(sealed.ciphertext), decipher.final()]).toString("utf8");
  } catch (err) {
    throw decryptionFailed(err);
  }
}

function userAad(userId: string): Buffer {
  return Buffer.from(`user:${userId}`, "utf8");
}

function accountAad(accountId: string): Buffer {
  return Buffer.from(`account:${accountId}`, "utf8");
}

function assertAesKey(key: Buffer): void {
  if (key.length !== AES_KEY_BYTES) throw new Error("Encryption key must be 32 bytes");
}

function assertLabel(value: string, name: string): void {
  if (value.trim() === "") throw new Error(`${name} is required`);
}

function decryptionFailed(err: unknown): Error {
  if (err instanceof Error && err.message === "Decryption failed") return err;
  return new Error("Decryption failed");
}
