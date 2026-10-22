import { create as createUser, remove as removeUser, setPassword as setUserPassword, verifyPassword } from "./users.js";
import { create as createApiKey, importToken as importApiKey, list as listApiKeys, resolve as resolveApiKey, revoke as revokeApiKey } from "./api-keys.js";
import {
  add as addMailAccount,
  list as listMailAccounts,
  remove as removeMailAccount,
  setSendEnabled,
} from "./mail-accounts.js";

export const users = {
  create: createUser,
  verifyPassword,
  setPassword: setUserPassword,
  remove: removeUser,
};

export const apiKeys = {
  create: createApiKey,
  importToken: importApiKey,
  list: listApiKeys,
  revoke: revokeApiKey,
  resolve: resolveApiKey,
};

export const mailAccounts = {
  add: addMailAccount,
  list: listMailAccounts,
  remove: removeMailAccount,
  setSendEnabled,
};

export { API_KEY_TOUCH_INTERVAL_MS, MAX_ACTIVE_KEYS_PER_USER } from "./api-keys.js";
export { MAX_MAIL_ACCOUNTS_PER_USER } from "./mail-accounts.js";
export type { ApiKeySummary, CreatedApiKey } from "./api-keys.js";
export type { MailAccountSummary, NewMailAccount } from "./mail-accounts.js";
export type { UserRecord } from "./users.js";
