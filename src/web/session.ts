import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type Database from "better-sqlite3";
import { SESSION_MAX_AGE_SECONDS } from "./cookies.js";

const SESSION_MS = SESSION_MAX_AGE_SECONDS * 1000;

export interface SessionRecord {
  userId: string;
  email: string;
  csrfSecret: string;
}

export function hashSessionId(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export function createSession(db: Database, userId: string, now = Date.now()): { token: string; csrfSecret: string } {
  purgeExpired(db, now);
  const token = randomBytes(32).toString("base64url");
  const csrfSecret = randomBytes(32).toString("base64url");
  const created = new Date(now).toISOString();
  db.prepare(
    `INSERT INTO sessions (id, user_id, csrf_secret, created_at, expires_at) VALUES (?, ?, ?, ?, ?)`,
  ).run(hashSessionId(token), userId, csrfSecret, created, new Date(now + SESSION_MS).toISOString());
  return { token, csrfSecret };
}

export function readSession(db: Database, token: string | undefined, now = Date.now()): SessionRecord | null {
  if (!token || token.length > 200) return null;
  purgeExpired(db, now);
  const row = db
    .prepare(
      `SELECT s.user_id, s.csrf_secret, u.email
       FROM sessions s
       JOIN users u ON u.id = s.user_id
       WHERE s.id = ?`,
    )
    .get(hashSessionId(token)) as { user_id: string; csrf_secret: string; email: string } | undefined;
  if (!row) return null;
  return { userId: row.user_id, email: row.email, csrfSecret: row.csrf_secret };
}

export function destroySession(db: Database, token: string | undefined): void {
  if (!token || token.length > 200) return;
  db.prepare("DELETE FROM sessions WHERE id = ?").run(hashSessionId(token));
}

function purgeExpired(db: Database, now: number): void {
  db.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(new Date(now).toISOString());
}
