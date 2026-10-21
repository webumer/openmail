import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import type Database from "better-sqlite3";
import { generateApiKey, hashApiKey } from "../crypto/api-key.js";
import { MailError } from "../errors.js";
import { requireId, requireLabel } from "./validate.js";

/** Skip last_used_at writes that are more frequent than this. */
export const API_KEY_TOUCH_INTERVAL_MS = 60_000;

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
  const generated = generateApiKey();
  const id = randomUUID();
  const createdAt = new Date().toISOString();
  db.prepare(
    `INSERT INTO api_keys (id, user_id, name, prefix, key_hash, created_at, last_used_at, revoked_at)
     VALUES (?, ?, ?, ?, ?, ?, NULL, NULL)`,
  ).run(id, userId, name, generated.prefix, generated.keyHash, createdAt);
  return { id, name, prefix: generated.prefix, token: generated.token, createdAt };
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
