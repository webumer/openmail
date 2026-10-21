import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { sealPassword, unwrapDataKey } from "../crypto/envelope.js";
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
}

export interface MailAccountSummary {
  id: string;
  name: string;
  email: string;
  preset: ProviderPreset;
  imapHost: string;
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
  const user = db.prepare("SELECT wrapped_data_key FROM users WHERE id = ?").get(userId) as
    | { wrapped_data_key: Buffer }
    | undefined;
  if (!user) throw new MailError("not_found", "User was not found");

  const id = randomUUID();
  const dataKey = unwrapDataKey(masterKey, userId, asBuffer(user.wrapped_data_key));
  try {
    const sealed = sealPassword(dataKey, id, password);
    try {
      db.prepare(
        `INSERT INTO mail_accounts (
           id, user_id, name, email, username, preset,
           imap_host, imap_port, imap_secure,
           smtp_host, smtp_port, smtp_secure, smtp_starttls,
           password_ciphertext, password_iv, password_tag, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
  return { id, name, email, preset, imapHost: endpoints.imap.host };
}

export function list(db: Database, userId: string): MailAccountSummary[] {
  const rows = db
    .prepare(
      `SELECT id, name, email, preset, imap_host
       FROM mail_accounts WHERE user_id = ? ORDER BY created_at, id`,
    )
    .all(requireId(userId, "userId")) as Array<{
    id: string;
    name: string;
    email: string;
    preset: string;
    imap_host: string;
  }>;
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    email: row.email,
    preset: parsePreset(row.preset),
    imapHost: row.imap_host,
  }));
}

export function remove(db: Database, userId: string, accountId: string): boolean {
  const result = db
    .prepare("DELETE FROM mail_accounts WHERE user_id = ? AND id = ?")
    .run(requireId(userId, "userId"), requireId(accountId, "accountId"));
  return result.changes === 1;
}

function asBuffer(value: unknown): Buffer {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  throw new Error("Decryption failed");
}
