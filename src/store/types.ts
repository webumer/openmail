import type { ImapEndpoint, ProviderPreset, SmtpEndpoint } from "../mail/presets.js";

export interface AccountSummary {
  id: string;
  label: string;
  email: string;
  preset: ProviderPreset;
  imapHost: string;
}

/** Connection settings plus the mailbox secret. Never log `password`. */
export interface AccountCredentials {
  id: string;
  label: string;
  email: string;
  preset: ProviderPreset;
  username: string;
  password: string;
  imap: ImapEndpoint;
  smtp: SmtpEndpoint;
  allowInsecureLocalhost: boolean;
  /**
   * Exact hostnames an operator has allowed to use plain IMAP, such as an
   * internal demo server on a private Docker network. Never set for
   * user-entered hosts (the web probe leaves it empty).
   */
  insecureImapHosts?: readonly string[];
}

/**
 * Per-user credential lookup.
 * `ConfigCredentialStore` ignores user id and serves single-user mode.
 * `SqliteCredentialStore` returns only that user's accounts and decrypts the
 * mailbox password when a connection is opened.
 */
export interface CredentialStore {
  listAccounts(userId: string): Promise<AccountSummary[]>;
  getAccount(userId: string, accountId: string): Promise<AccountCredentials | null>;
}
