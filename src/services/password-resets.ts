import { createHash, randomBytes, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { MailError } from "../errors.js";
import { hashUserPassword } from "./users.js";

export const RESET_TTL_MS = 30 * 60 * 1000;
const INVALID_RESET = "This password reset code is invalid or expired. Request a new link.";

function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function prunePasswordResets(db: Database, now = Date.now()): void {
  db.prepare("DELETE FROM password_resets WHERE expires_at <= ?").run(new Date(now).toISOString());
}

/** Only the hash is persisted. A new code retires all earlier unused codes. */
export function issuePasswordReset(db: Database, userId: string, now = Date.now()): string {
  const token = randomBytes(32).toString("base64url");
  db.transaction(() => {
    prunePasswordResets(db, now);
    const created = new Date(now).toISOString();
    db.prepare("UPDATE password_resets SET used_at = ? WHERE user_id = ? AND used_at IS NULL").run(created, userId);
    db.prepare(`INSERT INTO password_resets (id, user_id, token_hash, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?)`)
      .run(randomUUID(), userId, tokenHash(token), created, new Date(now + RESET_TTL_MS).toISOString());
  })();
  return token;
}

/** Recheck inside the transaction after hashing, including expiry and concurrent use. */
export async function completePasswordReset(
  db: Database,
  token: string,
  password: string,
  now: () => number = Date.now,
): Promise<void> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new MailError("invalid_reset", INVALID_RESET);
  const digest = tokenHash(token);
  const lookup = () => db.prepare(`SELECT user_id FROM password_resets
    WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?`)
    .get(digest, new Date(now()).toISOString()) as { user_id: string } | undefined;
  if (!lookup()) throw new MailError("invalid_reset", INVALID_RESET);
  const passwordHash = await hashUserPassword(password);
  db.transaction(() => {
    const row = lookup();
    if (!row) throw new MailError("invalid_reset", INVALID_RESET);
    db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(passwordHash, row.user_id);
    db.prepare("UPDATE password_resets SET used_at = ? WHERE user_id = ? AND used_at IS NULL")
      .run(new Date(now()).toISOString(), row.user_id);
    db.prepare("DELETE FROM sessions WHERE user_id = ?").run(row.user_id);
  })();
}
