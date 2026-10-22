import type Database from "better-sqlite3";
import { AES_KEY_BYTES, openPassword, openSmtpPassword, unwrapDataKey } from "../crypto/envelope.js";
import { MailError } from "../errors.js";
import { PROVIDER_PRESETS, type ProviderPreset } from "../mail/presets.js";
import type { AccountCredentials, AccountSummary, CredentialStore } from "./types.js";

export interface SqliteCredentialStoreOptions {
  allowInsecureLocalhost?: boolean;
  /** Operator allowlist for plain IMAP (see AccountCredentials.insecureImapHosts). */
  insecureImapHosts?: readonly string[];
  /** Operator allowlist for plain SMTP (see AccountCredentials.insecureSmtpHosts). */
  insecureSmtpHosts?: readonly string[];
}

interface AccountRow {
  id: string;
  name: string;
  email: string;
  username: string;
  preset: string;
  imap_host: string;
  imap_port: number;
  imap_secure: number;
  smtp_host: string;
  smtp_port: number;
  smtp_secure: number;
  smtp_starttls: number;
  password_ciphertext: Buffer;
  password_iv: Buffer;
  password_tag: Buffer;
  send_enabled: number;
  smtp_username: string | null;
  smtp_password_ciphertext: Buffer | null;
  smtp_password_iv: Buffer | null;
  smtp_password_tag: Buffer | null;
}

export class SqliteCredentialStore implements CredentialStore {
  private readonly masterKey: Buffer;
  private readonly allowInsecureLocalhost: boolean;
  private readonly insecureImapHosts: readonly string[];
  private readonly insecureSmtpHosts: readonly string[];

  constructor(
    private readonly db: Database,
    masterKey: Buffer,
    options: SqliteCredentialStoreOptions = {},
  ) {
    if (masterKey.length !== AES_KEY_BYTES) throw new Error("Master key must be 32 bytes");
    this.masterKey = Buffer.from(masterKey);
    this.allowInsecureLocalhost = options.allowInsecureLocalhost ?? false;
    this.insecureImapHosts = [...(options.insecureImapHosts ?? [])];
    this.insecureSmtpHosts = [...(options.insecureSmtpHosts ?? [])];
  }

  async listAccounts(userId: string): Promise<AccountSummary[]> {
    const rows = this.db
      .prepare(
        `SELECT id, name, email, preset, imap_host, send_enabled
         FROM mail_accounts WHERE user_id = ? ORDER BY created_at, id`,
      )
      .all(userId) as Array<Pick<AccountRow, "id" | "name" | "email" | "preset" | "imap_host" | "send_enabled">>;
    return rows.map((row) => ({
      id: row.id,
      label: row.name,
      email: row.email,
      preset: asPreset(row.preset),
      imapHost: row.imap_host,
      sendEnabled: row.send_enabled === 1,
    }));
  }

  async getAccount(userId: string, accountId: string): Promise<AccountCredentials | null> {
    // Agents may pass the id or the account name (names are unique per user).
    // Both lookups are scoped to this user, so another user's rows never match.
    const columns = `SELECT id, name, email, username, preset,
                imap_host, imap_port, imap_secure,
                smtp_host, smtp_port, smtp_secure, smtp_starttls,
                password_ciphertext, password_iv, password_tag,
                send_enabled, smtp_username,
                smtp_password_ciphertext, smtp_password_iv, smtp_password_tag
         FROM mail_accounts`;
    const row = (this.db.prepare(`${columns} WHERE user_id = ? AND id = ?`).get(userId, accountId) ??
      this.db.prepare(`${columns} WHERE user_id = ? AND name = ?`).get(userId, accountId)) as AccountRow | undefined;
    if (!row) return null;
    const user = this.db.prepare("SELECT wrapped_data_key FROM users WHERE id = ?").get(userId) as
      | { wrapped_data_key: Buffer }
      | undefined;
    if (!user) return null;
    const dataKey = unwrapDataKey(this.masterKey, userId, asBuffer(user.wrapped_data_key));
    try {
      const password = openPassword(dataKey, row.id, {
        iv: asBuffer(row.password_iv),
        tag: asBuffer(row.password_tag),
        ciphertext: asBuffer(row.password_ciphertext),
      });
      const smtpPass = row.smtp_password_ciphertext
        ? openSmtpPassword(dataKey, row.id, {
            iv: asBuffer(row.smtp_password_iv),
            tag: asBuffer(row.smtp_password_tag),
            ciphertext: asBuffer(row.smtp_password_ciphertext),
          })
        : password;
      const preset = asPreset(row.preset);
      return {
        id: row.id,
        label: row.name,
        email: row.email,
        preset,
        username: row.username,
        password,
        imap: { host: row.imap_host, port: row.imap_port, secure: row.imap_secure === 1 },
        smtp: {
          host: row.smtp_host,
          port: row.smtp_port,
          secure: row.smtp_secure === 1,
          starttls: row.smtp_starttls === 1,
        },
        allowInsecureLocalhost: this.allowInsecureLocalhost,
        sendEnabled: row.send_enabled === 1,
        smtpAuth: { user: row.smtp_username?.trim() || row.username, pass: smtpPass },
        autoSavesSent: preset === "gmail",
        ...(this.insecureImapHosts.length > 0 ? { insecureImapHosts: this.insecureImapHosts } : {}),
        ...(this.insecureSmtpHosts.length > 0 ? { insecureSmtpHosts: this.insecureSmtpHosts } : {}),
      };
    } finally {
      dataKey.fill(0);
    }
  }
}

function asPreset(value: string): ProviderPreset {
  if ((PROVIDER_PRESETS as readonly string[]).includes(value)) return value as ProviderPreset;
  throw new MailError("config_error", "Stored account preset is invalid");
}

function asBuffer(value: unknown): Buffer {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  throw new Error("Decryption failed");
}
