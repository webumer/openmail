import { create as createUser, verifyPassword } from "./users.js";
import { create as createApiKey, list as listApiKeys, resolve as resolveApiKey, revoke as revokeApiKey } from "./api-keys.js";
import { add as addMailAccount, list as listMailAccounts, remove as removeMailAccount } from "./mail-accounts.js";

export const users = {
  create: createUser,
  verifyPassword,
};

export const apiKeys = {
  create: createApiKey,
  list: listApiKeys,
  revoke: revokeApiKey,
  resolve: resolveApiKey,
};

export const mailAccounts = {
  add: addMailAccount,
  list: listMailAccounts,
  remove: removeMailAccount,
};

export { API_KEY_TOUCH_INTERVAL_MS } from "./api-keys.js";
export type { ApiKeySummary, CreatedApiKey } from "./api-keys.js";
export type { MailAccountSummary, NewMailAccount } from "./mail-accounts.js";
export type { UserRecord } from "./users.js";
