import type { AppConfig } from "../config/schema.js";
import { MailError } from "../errors.js";
import { resolveEndpoints } from "../mail/presets.js";
import type { AccountCredentials, AccountSummary, CredentialStore } from "./types.js";

export class ConfigCredentialStore implements CredentialStore {
  constructor(
    private readonly config: AppConfig,
    private readonly env: { readonly [key: string]: string | undefined } = process.env,
  ) {}

  async listAccounts(_userId: string): Promise<AccountSummary[]> {
    return this.config.accounts.map((account) => {
      const endpoints = resolveEndpoints(account);
      return {
        id: account.id,
        label: account.label,
        email: account.email,
        preset: account.preset,
        imapHost: endpoints.imap.host,
      };
    });
  }

  async getAccount(_userId: string, accountId: string): Promise<AccountCredentials | null> {
    const account = this.config.accounts.find((candidate) => candidate.id === accountId);
    if (!account) return null;
    const password = this.env[account.passwordEnv];
    if (!password) {
      throw new MailError(
        "missing_secret",
        `Environment variable ${account.passwordEnv} is not set for account ${account.id}`,
      );
    }
    const endpoints = resolveEndpoints(account);
    return {
      id: account.id,
      label: account.label,
      email: account.email,
      preset: account.preset,
      username: account.username ?? account.email,
      password,
      imap: endpoints.imap,
      smtp: endpoints.smtp,
      allowInsecureLocalhost: this.config.allowInsecureLocalhost,
    };
  }
}
