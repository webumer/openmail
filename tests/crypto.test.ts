import { describe, expect, it } from "vitest";
import {
  generateDataKey,
  generateTestMasterKey,
  loadMasterKey,
  openPassword,
  openSmtpPassword,
  sealPassword,
  sealSmtpPassword,
  unwrapDataKey,
  wrapDataKey,
} from "../src/crypto/index.js";

const PASSWORD = "mailbox-secret-значение";

describe("master key", () => {
  it("accepts a generated test key and refuses a missing or invalid key", () => {
    const encoded = generateTestMasterKey();
    const key = loadMasterKey(encoded);
    expect(key).toHaveLength(32);
    expect(key.toString("base64")).toBe(encoded);
    expect(generateTestMasterKey()).not.toBe(encoded);

    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = "test";
    try {
      expect(() => loadMasterKey(undefined)).toThrow("OPENMAIL_MASTER_KEY is not set");
      expect(() => loadMasterKey("")).toThrow("OPENMAIL_MASTER_KEY is not set");
      expect(() => loadMasterKey("   ")).toThrow("OPENMAIL_MASTER_KEY is not set");
    } finally {
      if (previous === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previous;
    }

    expect(() => loadMasterKey("not a key")).toThrow(/invalid/);
    expect(() => loadMasterKey(Buffer.alloc(16).toString("base64"))).toThrow(/invalid/);
    expect(() => loadMasterKey(Buffer.alloc(64).toString("base64"))).toThrow(/invalid/);
    expect(() => loadMasterKey(`${encoded.slice(0, -2)}AA`)).toThrow(/invalid/);
  });
});

describe("envelope encryption", () => {
  it("round-trips a user data key and a mailbox password", () => {
    const master = loadMasterKey(generateTestMasterKey());
    const userId = "user-1";
    const accountId = "account-1";
    const dataKey = generateDataKey();
    const wrapped = wrapDataKey(master, userId, dataKey);
    expect(wrapped).toHaveLength(12 + 16 + 32);
    expect(wrapped.toString("utf8")).not.toContain(PASSWORD);
    const unwrapped = unwrapDataKey(master, userId, wrapped);
    expect(unwrapped.equals(dataKey)).toBe(true);

    const sealed = sealPassword(dataKey, accountId, PASSWORD);
    const again = sealPassword(dataKey, accountId, PASSWORD);
    expect(again.iv.equals(sealed.iv)).toBe(false);
    expect(openPassword(dataKey, accountId, sealed)).toBe(PASSWORD);
    const smtpSealed = sealSmtpPassword(dataKey, accountId, PASSWORD);
    expect(openSmtpPassword(dataKey, accountId, smtpSealed)).toBe(PASSWORD);
    expect(() => openPassword(dataKey, accountId, smtpSealed)).toThrow("Decryption failed");
    expect(() => openSmtpPassword(dataKey, accountId, sealed)).toThrow("Decryption failed");
    expect(sealed.ciphertext.toString("utf8")).not.toContain(PASSWORD);
    unwrapped.fill(0);
    dataKey.fill(0);
  });

  it("rejects a flipped iv, tag, or ciphertext", () => {
    const master = loadMasterKey(generateTestMasterKey());
    const dataKey = generateDataKey();
    const wrapped = wrapDataKey(master, "user-1", dataKey);
    expect(() => unwrapDataKey(master, "user-1", flip(wrapped, 0))).toThrow("Decryption failed");
    expect(() => unwrapDataKey(master, "user-1", flip(wrapped, 12))).toThrow("Decryption failed");
    expect(() => unwrapDataKey(master, "user-1", flip(wrapped, 28))).toThrow("Decryption failed");

    const sealed = sealPassword(dataKey, "account-1", PASSWORD);
    expect(() => openPassword(dataKey, "account-1", { ...sealed, iv: flip(sealed.iv, 0) })).toThrow("Decryption failed");
    expect(() => openPassword(dataKey, "account-1", { ...sealed, tag: flip(sealed.tag, 0) })).toThrow(
      "Decryption failed",
    );
    expect(() => openPassword(dataKey, "account-1", { ...sealed, ciphertext: flip(sealed.ciphertext, 0) })).toThrow(
      "Decryption failed",
    );
  });

  it("rejects the wrong user id, the wrong account id, and the wrong key", () => {
    const master = loadMasterKey(generateTestMasterKey());
    const otherMaster = loadMasterKey(generateTestMasterKey());
    const dataKey = generateDataKey();
    const otherKey = generateDataKey();
    const wrapped = wrapDataKey(master, "user-a", dataKey);
    expect(() => unwrapDataKey(master, "user-b", wrapped)).toThrow("Decryption failed");
    expect(() => unwrapDataKey(otherMaster, "user-a", wrapped)).toThrow("Decryption failed");

    const sealed = sealPassword(dataKey, "account-a", PASSWORD);
    expect(() => openPassword(dataKey, "account-b", sealed)).toThrow("Decryption failed");
    expect(() => openPassword(otherKey, "account-a", sealed)).toThrow("Decryption failed");
  });
});

function flip(buf: Buffer, index: number): Buffer {
  const copy = Buffer.from(buf);
  const byte = copy[index];
  if (byte === undefined) throw new Error("flip index out of range");
  copy[index] = byte ^ 0xff;
  return copy;
}
