import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";

export const SEND_LOG_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
export const HOUR_MS = 60 * 60 * 1000;
export const DAY_MS = 24 * HOUR_MS;
/** Reservations older than this at startup were left behind by a crash. */
export const STALE_SEND_MS = 5 * 60 * 1000;

export interface SendLimits {
  perHour: number;
  perDay: number;
  maxRecipients: number;
}

export interface SendLogRow {
  id: string;
  accountLabel: string;
  createdAt: string;
  status: "sent" | "failed";
  recipients: number;
  messageId: string | null;
  errorCode: string | null;
  via: string;
}

export interface SendRecorder {
  reserve(
    attempt: SendReservation,
    limits: Pick<SendLimits, "perHour" | "perDay">,
    now?: number,
  ): { ok: true; id: string } | { ok: false; retryAt: string };
  finish(
    id: string,
    status: "sent" | "failed",
    messageId: string | null,
    errorCode: string | null,
    recipients?: number,
  ): void;
}

export interface SendReservation {
  userId: string;
  accountId: string;
  accountLabel: string;
  recipients: number;
  via: string;
}

const DEFAULTS: SendLimits = { perHour: 20, perDay: 100, maxRecipients: 20 };

export function sendLimitsFromEnv(env: Record<string, string | undefined> = process.env): SendLimits {
  return {
    perHour: positive(env.OPENMAIL_SEND_MAX_PER_HOUR, DEFAULTS.perHour),
    perDay: positive(env.OPENMAIL_SEND_MAX_PER_DAY, DEFAULTS.perDay),
    maxRecipients: positive(env.OPENMAIL_SEND_MAX_RECIPIENTS, DEFAULTS.maxRecipients),
  };
}

/** Drops rows older than 90 days. Safe to call on startup and before each insert. */
export function pruneSendLog(db: Database, now = Date.now()): void {
  db.prepare("DELETE FROM send_log WHERE created_at < ?").run(new Date(now - SEND_LOG_RETENTION_MS).toISOString());
}

/**
 * Counts recent attempts and inserts a row in one immediate transaction, so
 * the count and the insert share a write lock. The row counts toward the
 * limit immediately, including while it is still in progress.
 */
export function reserveSend(
  db: Database,
  attempt: SendReservation,
  limits: Pick<SendLimits, "perHour" | "perDay">,
  now = Date.now(),
): { ok: true; id: string } | { ok: false; retryAt: string } {
  const run = db.transaction((): { ok: true; id: string } | { ok: false; retryAt: string } => {
    pruneSendLog(db, now);
    const retryAt = earliestRetry(db, attempt, limits, now);
    if (retryAt) return { ok: false, retryAt };
    const id = randomUUID();
    db.prepare(
      `INSERT INTO send_log (
         id, user_id, account_id, account_label, created_at, status, recipients, message_id, error_code, via
       ) VALUES (?, ?, ?, ?, ?, 'failed', ?, NULL, 'in_progress', ?)`,
    ).run(id, attempt.userId, attempt.accountId, attempt.accountLabel, new Date(now).toISOString(), attempt.recipients, attempt.via);
    return { ok: true, id };
  });
  return run.immediate();
}

/** A reservation left in progress for more than 5 minutes did not finish. It still counts. */
export function interruptStaleSends(db: Database, now = Date.now()): void {
  const cutoff = new Date(now - STALE_SEND_MS).toISOString();
  db.prepare("UPDATE send_log SET error_code = 'interrupted' WHERE error_code = 'in_progress' AND created_at < ?").run(cutoff);
}

export function finishSend(
  db: Database,
  id: string,
  status: "sent" | "failed",
  messageId: string | null,
  errorCode: string | null,
  recipients?: number,
): void {
  if (recipients === undefined) {
    db.prepare("UPDATE send_log SET status = ?, message_id = ?, error_code = ? WHERE id = ?").run(
      status,
      messageId,
      errorCode,
      id,
    );
    return;
  }
  db.prepare("UPDATE send_log SET status = ?, message_id = ?, error_code = ?, recipients = ? WHERE id = ?").run(
    status,
    messageId,
    errorCode,
    recipients,
    id,
  );
}

export function listSendLog(db: Database, userId: string, limit = 50): SendLogRow[] {
  const rows = db
    .prepare(
      `SELECT id, account_label, created_at, status, recipients, message_id, error_code, via
       FROM send_log WHERE user_id = ?
       ORDER BY created_at DESC, id DESC LIMIT ?`,
    )
    .all(userId, limit) as Array<{
    id: string;
    account_label: string;
    created_at: string;
    status: "sent" | "failed";
    recipients: number;
    message_id: string | null;
    error_code: string | null;
    via: string;
  }>;
  return rows.map((row) => ({
    id: row.id,
    accountLabel: row.account_label,
    createdAt: row.created_at,
    status: row.status,
    recipients: row.recipients,
    messageId: row.message_id,
    errorCode: row.error_code,
    via: row.via,
  }));
}

function earliestRetry(
  db: Database,
  attempt: SendReservation,
  limits: Pick<SendLimits, "perHour" | "perDay">,
  now: number,
): string | null {
  const checks: Array<{ where: string; params: string[]; since: number; windowMs: number; limit: number }> = [
    { where: "user_id = ?", params: [attempt.userId], since: now - HOUR_MS, windowMs: HOUR_MS, limit: limits.perHour },
    { where: "user_id = ?", params: [attempt.userId], since: now - DAY_MS, windowMs: DAY_MS, limit: limits.perDay },
    {
      where: "user_id = ? AND account_id = ?",
      params: [attempt.userId, attempt.accountId],
      since: now - HOUR_MS,
      windowMs: HOUR_MS,
      limit: limits.perHour,
    },
    {
      where: "user_id = ? AND account_id = ?",
      params: [attempt.userId, attempt.accountId],
      since: now - DAY_MS,
      windowMs: DAY_MS,
      limit: limits.perDay,
    },
  ];
  let latest: number | null = null;
  for (const check of checks) {
    const at = retryAt(db, check.where, check.params, check.since, check.windowMs, check.limit, now);
    if (at !== null && (latest === null || at > latest)) latest = at;
  }
  return latest === null ? null : new Date(latest).toISOString();
}

function retryAt(
  db: Database,
  where: string,
  params: string[],
  sinceMs: number,
  windowMs: number,
  limit: number,
  now: number,
): number | null {
  const since = new Date(sinceMs).toISOString();
  const count = db.prepare(`SELECT COUNT(*) AS n FROM send_log WHERE ${where} AND created_at >= ?`).get(...params, since) as {
    n: number;
  };
  if (count.n < limit) return null;
  const row = db
    .prepare(
      `SELECT created_at FROM send_log WHERE ${where} AND created_at >= ? ORDER BY created_at ASC, id ASC LIMIT 1 OFFSET ?`,
    )
    .get(...params, since, count.n - limit) as { created_at: string } | undefined;
  const created = row ? Date.parse(row.created_at) : now;
  return (Number.isNaN(created) ? now : created) + windowMs;
}

export function createSqliteSendRecorder(db: Database): SendRecorder {
  return {
    reserve: (attempt, limits, now) => reserveSend(db, attempt, limits, now),
    finish: (id, status, messageId, errorCode, recipients) => finishSend(db, id, status, messageId, errorCode, recipients),
  };
}

export function createMemorySendRecorder(): SendRecorder {
  const rows: Array<SendReservation & { id: string; createdAt: string; status: "sent" | "failed"; errorCode: string | null }> = [];
  return {
    reserve(attempt, limits, now = Date.now()) {
      const cutoff = now - SEND_LOG_RETENTION_MS;
      for (let i = rows.length - 1; i >= 0; i -= 1) {
        if (Date.parse(rows[i]?.createdAt ?? "") < cutoff) rows.splice(i, 1);
      }
      const retry = memoryRetry(rows, attempt, limits, now);
      if (retry) return { ok: false, retryAt: new Date(retry).toISOString() };
      const id = randomUUID();
      rows.push({ ...attempt, id, createdAt: new Date(now).toISOString(), status: "failed", errorCode: "in_progress" });
      return { ok: true, id };
    },
    finish(id, status, _messageId, errorCode, recipients) {
      const row = rows.find((item) => item.id === id);
      if (!row) return;
      row.status = status;
      row.errorCode = errorCode;
      if (recipients !== undefined) row.recipients = recipients;
    },
  };
}

function memoryRetry(
  rows: ReadonlyArray<{ userId: string; accountId: string; createdAt: string }>,
  attempt: SendReservation,
  limits: Pick<SendLimits, "perHour" | "perDay">,
  now: number,
): number | null {
  const checks = [
    { match: (row: { userId: string; accountId: string }) => row.userId === attempt.userId, windowMs: HOUR_MS, limit: limits.perHour },
    { match: (row: { userId: string; accountId: string }) => row.userId === attempt.userId, windowMs: DAY_MS, limit: limits.perDay },
    {
      match: (row: { userId: string; accountId: string }) => row.userId === attempt.userId && row.accountId === attempt.accountId,
      windowMs: HOUR_MS,
      limit: limits.perHour,
    },
    {
      match: (row: { userId: string; accountId: string }) => row.userId === attempt.userId && row.accountId === attempt.accountId,
      windowMs: DAY_MS,
      limit: limits.perDay,
    },
  ];
  let latest: number | null = null;
  for (const check of checks) {
    const windowRows = rows
      .filter((row) => check.match(row) && Date.parse(row.createdAt) >= now - check.windowMs)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    if (windowRows.length < check.limit) continue;
    const edge = windowRows[windowRows.length - check.limit];
    const at = (edge ? Date.parse(edge.createdAt) : now) + check.windowMs;
    if (latest === null || at > latest) latest = at;
  }
  return latest;
}

function positive(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 10_000) return fallback;
  return value;
}
