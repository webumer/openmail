import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import type Database from "better-sqlite3";
import { API_KEY_PREFIX_LENGTH, generateApiKey, hashApiKey } from "../crypto/api-key.js";
import { MailError } from "../errors.js";
import { requireId, requireLabel } from "./validate.js";

/** Skip last_used_at writes that are more frequent than this. */
export const API_KEY_TOUCH_INTERVAL_MS = 60_000;

/** Active (not revoked) keys per user. Revoke one to create another. */
export const MAX_ACTIVE_KEYS_PER_USER = 25;

const DUMMY_KEY_HASH = createHash("sha256").update("openmail-unknown-api-key").digest();

export interface CreatedApiKey {
  id: string;
  name: string;
  prefix: string;
  token: string;
  createdAt: string;
}

export interface ApiKeySummary {
  id: string;
  name: string;
  prefix: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

interface KeyRow {
  id: string;
  user_id: string;
  name: string;
  prefix: string;
  key_hash: string;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

export function create(db: Database, input: { userId: string; name: string }): CreatedApiKey {
  const userId = requireId(input.userId, "userId");
  const name = requireLabel(input.name, "Key name");
  const user = db.prepare("SELECT id FROM users WHERE id = ?").get(userId);
  if (!user) throw new MailError("not_found", "User was not found");
  const active = db
    .prepare("SELECT COUNT(*) AS n FROM api_keys WHERE user_id = ? AND revoked_at IS NULL")
    .get(userId) as { n: number };
  if (active.n >= MAX_ACTIVE_KEYS_PER_USER) {
    throw new MailError("limit_reached", `You can have up to ${MAX_ACTIVE_KEYS_PER_USER} active API keys; revoke one first`);
  }
  const generated = generateApiKey();
  const id = randomUUID();
  const createdAt = new Date().toISOString();
  db.prepare(
    `INSERT INTO api_keys (id, user_id, name, prefix, key_hash, created_at, last_used_at, revoked_at)
     VALUES (?, ?, ?, ?, ?, ?, NULL, NULL)`,
  ).run(id, userId, name, generated.prefix, generated.keyHash, createdAt);
  return { id, name, prefix: generated.prefix, token: generated.token, createdAt };
}

/**
 * Register an existing bearer token (for example one issued in single-user
 * mode) as a key of this user. Only its SHA-256 hash and display prefix are
 * stored. Used by the admin CLI for migrations; the web app always generates.
 */
export function importToken(
  db: Database,
  input: { userId: string; name: string; token: string },
): Omit<CreatedApiKey, "token"> {
  const userId = requireId(input.userId, "userId");
  const name = requireLabel(input.name, "Key name");
  const token = typeof input.token === "string" ? input.token.trim() : "";
  if (token.length < 32 || token.length > 200 || /\s/.test(token)) {
    throw new MailError("invalid_input", "Imported key must be 32 to 200 characters with no spaces");
  }
  const user = db.prepare("SELECT id FROM users WHERE id = ?").get(userId);
  if (!user) throw new MailError("not_found", "User was not found");
  const keyHash = hashApiKey(token);
  if (db.prepare("SELECT id FROM api_keys WHERE key_hash = ?").get(keyHash)) {
    throw new MailError("conflict", "That key is already registered");
  }
  const id = randomUUID();
  const createdAt = new Date().toISOString();
  const prefix = token.slice(0, API_KEY_PREFIX_LENGTH);
  db.prepare(
    `INSERT INTO api_keys (id, user_id, name, prefix, key_hash, created_at, last_used_at, revoked_at)
     VALUES (?, ?, ?, ?, ?, ?, NULL, NULL)`,
  ).run(id, userId, name, prefix, keyHash, createdAt);
  return { id, name, prefix, createdAt };
}

export function list(db: Database, userId: string): ApiKeySummary[] {
  const rows = db
    .prepare(
      `SELECT id, name, prefix, created_at, last_used_at, revoked_at
       FROM api_keys WHERE user_id = ? ORDER BY created_at, id`,
    )
    .all(requireId(userId, "userId")) as Array<
    Pick<KeyRow, "id" | "name" | "prefix" | "created_at" | "last_used_at" | "revoked_at">
  >;
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    prefix: row.prefix,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    revokedAt: row.revoked_at,
  }));
}

export function revoke(db: Database, userId: string, keyId: string): boolean {
  const result = db
    .prepare(
      `UPDATE api_keys SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL`,
    )
    .run(new Date().toISOString(), requireId(keyId, "keyId"), requireId(userId, "userId"));
  return result.changes === 1;
}

export function resolve(
  db: Database,
  token: string,
  now = Date.now(),
): { userId: string; keyId: string } | null {
  if (typeof token !== "string" || token.length === 0) return null;
  const digest = createHash("sha256").update(token, "utf8").digest();
  const row = db
    .prepare("SELECT id, user_id, key_hash, revoked_at, last_used_at FROM api_keys WHERE key_hash = ?")
    .get(hashApiKey(token)) as Pick<KeyRow, "id" | "user_id" | "key_hash" | "revoked_at" | "last_used_at"> | undefined;
  const stored = row ? Buffer.from(row.key_hash, "hex") : DUMMY_KEY_HASH;
  const matches = stored.length === digest.length && timingSafeEqual(stored, digest);
  if (!row || !matches || row.revoked_at) return null;
  if (shouldTouch(row.last_used_at, now)) {
    db.prepare("UPDATE api_keys SET last_used_at = ? WHERE id = ?").run(new Date(now).toISOString(), row.id);
  }
  return { userId: row.user_id, keyId: row.id };
}

function shouldTouch(lastUsedAt: string | null, now: number): boolean {
  if (!lastUsedAt) return true;
  const then = Date.parse(lastUsedAt);
  if (Number.isNaN(then)) return true;
  return now - then >= API_KEY_TOUCH_INTERVAL_MS;
}
