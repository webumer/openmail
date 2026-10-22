import { afterEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { API_KEY_PREFIX_LENGTH, generateApiKey, generateTestMasterKey, hashApiKey, loadMasterKey } from "../src/crypto/index.js";
import { migrate, openDatabase } from "../src/db/index.js";
import { API_KEY_TOUCH_INTERVAL_MS, apiKeys, users } from "../src/services/index.js";
import { hashApiKeys } from "../src/server/auth.js";

const open: Database[] = [];

afterEach(() => {
  for (const db of open) db.close();
  open.length = 0;
});

describe("api key generation", () => {
  it("builds an om_ key, a short prefix, and a SHA-256 hex hash", () => {
    const first = generateApiKey();
    const second = generateApiKey();
    expect(first.token).toMatch(/^om_[A-Za-z0-9_-]{40}$/);
    expect(first.prefix).toHaveLength(API_KEY_PREFIX_LENGTH);
    expect(first.prefix).toBe(first.token.slice(0, API_KEY_PREFIX_LENGTH));
    expect(first.keyHash).toMatch(/^[a-f0-9]{64}$/);
    expect(first.keyHash).toBe(hashApiKey(first.token));
    expect(hashApiKeys(first.token)[0]?.toString("hex")).toBe(first.keyHash);
    expect(first.token).not.toBe(second.token);
    expect(first.keyHash).not.toContain(first.token);
  });
});

describe("api key records", () => {
  it("stores only the hash, lists the prefix, throttles last_used_at, and rejects a revoked key", async () => {
    const db = openDatabase(":memory:");
    open.push(db);
    migrate(db);
    const master = loadMasterKey(generateTestMasterKey());
    const owner = await users.create(db, master, { email: "owner@example.com", password: "owner-password-1" });
    const other = await users.create(db, master, { email: "other@example.com", password: "other-password-1" });
    const created = apiKeys.create(db, { userId: owner.id, name: "Laptop" });

    expect(created.token).toMatch(/^om_[A-Za-z0-9_-]{40}$/);
    const stored = db.prepare("SELECT * FROM api_keys WHERE id = ?").get(created.id) as Record<string, unknown>;
    expect(JSON.stringify(stored)).not.toContain(created.token);
    expect(stored.key_hash).toBe(hashApiKey(created.token));
    expect(stored.prefix).toBe(created.prefix);
    expect(stored.user_id).toBe(owner.id);

    const listed = apiKeys.list(db, owner.id);
    expect(listed).toEqual([
      {
        id: created.id,
        name: "Laptop",
        prefix: created.prefix,
        createdAt: created.createdAt,
        lastUsedAt: null,
        revokedAt: null,
        canSend: false,
      },
    ]);
    expect(JSON.stringify(listed)).not.toContain(created.token);

    const t0 = Date.parse("2026-01-01T00:00:00.000Z");
    expect(apiKeys.resolve(db, created.token, t0)).toEqual({
      userId: owner.id,
      keyId: created.id,
      canSend: false,
      name: "Laptop",
    });
    expect(apiKeys.list(db, owner.id)[0]?.lastUsedAt).toBe(new Date(t0).toISOString());
    expect(apiKeys.resolve(db, created.token, t0 + 1_000)).toEqual({
      userId: owner.id,
      keyId: created.id,
      canSend: false,
      name: "Laptop",
    });
    expect(apiKeys.list(db, owner.id)[0]?.lastUsedAt).toBe(new Date(t0).toISOString());
    const later = t0 + API_KEY_TOUCH_INTERVAL_MS;
    expect(apiKeys.resolve(db, created.token, later)?.keyId).toBe(created.id);
    expect(apiKeys.list(db, owner.id)[0]?.lastUsedAt).toBe(new Date(later).toISOString());

    expect(apiKeys.resolve(db, "om_not-a-real-key")).toBeNull();
    expect(apiKeys.revoke(db, other.id, created.id)).toBe(false);
    expect(apiKeys.resolve(db, created.token, later)?.userId).toBe(owner.id);
    expect(apiKeys.revoke(db, owner.id, created.id)).toBe(true);
    expect(apiKeys.revoke(db, owner.id, created.id)).toBe(false);
    expect(apiKeys.resolve(db, created.token, later + API_KEY_TOUCH_INTERVAL_MS)).toBeNull();
    expect(apiKeys.list(db, owner.id)[0]?.revokedAt).toEqual(expect.any(String));
    expect(apiKeys.list(db, other.id)).toEqual([]);
  });

  it("stores send permission only when asked", async () => {
    const db = openDatabase(":memory:");
    open.push(db);
    migrate(db);
    const master = loadMasterKey(generateTestMasterKey());
    const owner = await users.create(db, master, { email: "ada@example.com", password: "correct-horse" });
    const readOnly = apiKeys.create(db, { userId: owner.id, name: "Read" });
    const sending = apiKeys.create(db, { userId: owner.id, name: "Send", canSend: true });
    expect(readOnly.canSend).toBe(false);
    expect(sending.canSend).toBe(true);
    expect(apiKeys.resolve(db, readOnly.token)?.canSend).toBe(false);
    expect(apiKeys.resolve(db, sending.token)?.canSend).toBe(true);
    expect(apiKeys.list(db, owner.id).map((key) => [key.name, key.canSend]).sort()).toEqual([
      ["Read", false],
      ["Send", true],
    ]);
  });
});
