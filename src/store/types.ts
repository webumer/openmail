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
}

/**
 * Per-user credential lookup.
 * TODO(M3): replace the config-backed stub with a per-user encrypted store.
 * The M1 implementation returns the single config tenant for every user id.
 */
export interface CredentialStore {
  listAccounts(userId: string): Promise<AccountSummary[]>;
  getAccount(userId: string, accountId: string): Promise<AccountCredentials | null>;
}
