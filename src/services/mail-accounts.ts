import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { sealPassword, sealSmtpPassword, unwrapDataKey } from "../crypto/envelope.js";
import { isUniqueConstraint } from "../db/constraint.js";
import { MailError } from "../errors.js";
import { resolveEndpoints, type ProviderPreset } from "../mail/presets.js";
import {
  parseEmail,
  parsePreset,
  parseZohoRegion,
  requireId,
  requireLabel,
  requireMailboxPassword,
} from "./validate.js";

/** Keeps one account from storing unbounded rows or fanning out unbounded IMAP logins. */
export const MAX_MAIL_ACCOUNTS_PER_USER = 25;

export interface NewMailAccount {
  userId: string;
  name: string;
  email: string;
  username?: string;
  preset: string;
  password: string;
  zohoRegion?: string;
  imapHost?: string;
  imapPort?: number;
  imapSecure?: boolean;
  smtpHost?: string;
  smtpPort?: number;
  smtpSecure?: boolean;
  smtpStarttls?: boolean;
  /** Optional login used only for SMTP. Blank means the IMAP username and password. */
  smtpUsername?: string;
  smtpPassword?: string;
}

export interface MailAccountSummary {
  id: string;
  name: string;
  email: string;
  preset: ProviderPreset;
  imapHost: string;
  sendEnabled: boolean;
  smtpHost: string;
  smtpPort: number;
  smtpSecure: boolean;
  smtpStarttls: boolean;
}

export function add(db: Database, masterKey: Buffer, input: NewMailAccount): MailAccountSummary {
  const userId = requireId(input.userId, "userId");
  const name = requireLabel(input.name, "Account name");
  const email = parseEmail(input.email);
  const password = requireMailboxPassword(input.password);
  const preset = parsePreset(input.preset);
  const endpoints = resolveEndpoints({
    preset,
    zohoRegion: parseZohoRegion(input.zohoRegion),
    imapHost: input.imapHost,
    imapPort: input.imapPort,
    imapSecure: input.imapSecure,
    smtpHost: input.smtpHost,
    smtpPort: input.smtpPort,
    smtpSecure: input.smtpSecure,
    smtpStarttls: input.smtpStarttls,
  });
  const username = input.username?.trim() ? input.username.trim() : email;
  const smtpLogin = separateSmtpLogin(input.smtpUsername, input.smtpPassword);
  const user = db.prepare("SELECT wrapped_data_key FROM users WHERE id = ?").get(userId) as
    | { wrapped_data_key: Buffer }
    | undefined;
  if (!user) throw new MailError("not_found", "User was not found");
  const count = db.prepare("SELECT COUNT(*) AS n FROM mail_accounts WHERE user_id = ?").get(userId) as { n: number };
  if (count.n >= MAX_MAIL_ACCOUNTS_PER_USER) {
    throw new MailError("limit_reached", `You can add up to ${MAX_MAIL_ACCOUNTS_PER_USER} mail accounts`);
  }

  const id = randomUUID();
  const dataKey = unwrapDataKey(masterKey, userId, asBuffer(user.wrapped_data_key));
  try {
    const sealed = sealPassword(dataKey, id, password);
    const smtpSealed = smtpLogin ? sealSmtpPassword(dataKey, id, smtpLogin.password) : null;
    try {
      db.prepare(
        `INSERT INTO mail_accounts (
           id, user_id, name, email, username, preset,
           imap_host, imap_port, imap_secure,
           smtp_host, smtp_port, smtp_secure, smtp_starttls,
           password_ciphertext, password_iv, password_tag, created_at,
           send_enabled, smtp_username, smtp_password_ciphertext, smtp_password_iv, smtp_password_tag
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)`,
      ).run(
        id,
        userId,
        name,
        email,
        username,
        preset,
        endpoints.imap.host,
        endpoints.imap.port,
        endpoints.imap.secure ? 1 : 0,
        endpoints.smtp.host,
        endpoints.smtp.port,
        endpoints.smtp.secure ? 1 : 0,
        endpoints.smtp.starttls ? 1 : 0,
        sealed.ciphertext,
        sealed.iv,
        sealed.tag,
        new Date().toISOString(),
        smtpLogin?.username ?? null,
        smtpSealed?.ciphertext ?? null,
        smtpSealed?.iv ?? null,
        smtpSealed?.tag ?? null,
      );
    } catch (err) {
      if (isUniqueConstraint(err)) {
        throw new MailError("conflict", "An account with that name already exists");
      }
      throw err;
    }
  } finally {
    dataKey.fill(0);
  }
  return summaryFrom(id, name, email, preset, endpoints.imap.host, endpoints.smtp, false);
}

export function list(db: Database, userId: string): MailAccountSummary[] {
  const rows = db
    .prepare(
      `SELECT id, name, email, preset, imap_host, send_enabled, smtp_host, smtp_port, smtp_secure, smtp_starttls
       FROM mail_accounts WHERE user_id = ? ORDER BY created_at, id`,
    )
    .all(requireId(userId, "userId")) as Array<{
    id: string;
    name: string;
    email: string;
    preset: string;
    imap_host: string;
    send_enabled: number;
    smtp_host: string;
    smtp_port: number;
    smtp_secure: number;
    smtp_starttls: number;
  }>;
  return rows.map((row) =>
    summaryFrom(row.id, row.name, row.email, parsePreset(row.preset), row.imap_host, {
      host: row.smtp_host,
      port: row.smtp_port,
      secure: row.smtp_secure === 1,
      starttls: row.smtp_starttls === 1,
    }, row.send_enabled === 1),
  );
}

/** Turns sending on or off. The caller verifies SMTP before turning it on. */
export function setSendEnabled(db: Database, userId: string, accountId: string, enabled: boolean): boolean {
  const result = db
    .prepare("UPDATE mail_accounts SET send_enabled = ? WHERE user_id = ? AND id = ?")
    .run(enabled ? 1 : 0, requireId(userId, "userId"), requireId(accountId, "accountId"));
  return result.changes === 1;
}

export function remove(db: Database, userId: string, accountId: string): boolean {
  const result = db
    .prepare("DELETE FROM mail_accounts WHERE user_id = ? AND id = ?")
    .run(requireId(userId, "userId"), requireId(accountId, "accountId"));
  return result.changes === 1;
}

function separateSmtpLogin(
  username: string | undefined,
  password: string | undefined,
): { username: string; password: string } | null {
  const user = username?.trim() ?? "";
  const pass = password ?? "";
  if (!user && !pass) return null;
  if (!user || !pass) {
    throw new MailError("invalid_argument", "Enter both the SMTP username and password, or leave both blank");
  }
  if (user.length > 200) throw new MailError("invalid_argument", "SMTP username must be at most 200 characters");
  if (pass.length > 1000) throw new MailError("invalid_argument", "SMTP password must be at most 1000 characters");
  return { username: user, password: pass };
}

function summaryFrom(
  id: string,
  name: string,
  email: string,
  preset: ProviderPreset,
  imapHost: string,
  smtp: { host: string; port: number; secure: boolean; starttls: boolean },
  sendEnabled: boolean,
): MailAccountSummary {
  return {
    id,
    name,
    email,
    preset,
    imapHost,
    sendEnabled,
    smtpHost: smtp.host,
    smtpPort: smtp.port,
    smtpSecure: smtp.secure,
    smtpStarttls: smtp.starttls,
  };
}

function asBuffer(value: unknown): Buffer {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  throw new Error("Decryption failed");
}
