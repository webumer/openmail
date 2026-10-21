import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { loadMasterKey } from "./crypto/index.js";
import {
  loadConfig,
  parseConfig,
  resolveOpenMailMode,
  type AccountConfig,
  type AppConfig,
  type OpenMailMode,
  type ServerConfig,
} from "./config/index.js";
import { migrate, openDatabase, resolveDatabasePath } from "./db/index.js";
import { MailError } from "./errors.js";
import {
  createImapGateway,
  listAccounts,
  listFolders,
  readMessage,
  readThread,
  searchMessages,
  type ImapGateway,
  type ToolResult,
} from "./mail/index.js";
import { authenticateDatabaseKey, createOpenMailServer, hashApiKeys, listenOn } from "./server/index.js";
import { apiKeys, mailAccounts, users } from "./services/index.js";
import {
  ConfigCredentialStore,
  SqliteCredentialStore,
  type AccountCredentials,
  type AccountSummary,
  type CredentialStore,
} from "./store/index.js";

export { loadConfig, parseConfig, resolveOpenMailMode, type AccountConfig, type AppConfig, type OpenMailMode, type ServerConfig };
export { loadMasterKey, generateTestMasterKey } from "./crypto/index.js";
export { migrate, openDatabase, resolveDatabasePath };
export { apiKeys, mailAccounts, users };
export {
  ConfigCredentialStore,
  SqliteCredentialStore,
  type AccountCredentials,
  type AccountSummary,
  type CredentialStore,
};
export {
  createImapGateway,
  listAccounts,
  listFolders,
  readMessage,
  readThread,
  searchMessages,
  type ImapGateway,
  type ToolResult,
};
export { authenticateDatabaseKey, createOpenMailServer, hashApiKeys, listenOn };

const invoked = process.argv[1];
if (invoked && import.meta.url === pathToFileURL(invoked).href) {
  start().catch((err: unknown) => {
    if (err instanceof MailError || err instanceof Error) console.error(err.message);
    else console.error("OpenMail failed to start");
    process.exit(1);
  });
}

async function start(): Promise<void> {
  const configPath = process.env.OPENMAIL_CONFIG ?? "./config.toml";
  const modeWithoutConfig = resolveOpenMailMode(process.env);
  const config = existsSync(configPath) || modeWithoutConfig === "single" ? loadConfig(configPath) : undefined;
  const mode = resolveOpenMailMode(process.env, config?.mode);
  if (mode === "single") {
    if (!config) throw new MailError("config_error", `Cannot read config file: ${configPath}`);
    await listenSingle(config);
    return;
  }
  await listenMulti(config);
}

async function listenSingle(config: AppConfig): Promise<void> {
  const apiKeyHashes = hashApiKeys(process.env.OPENMAIL_API_KEYS);
  if (apiKeyHashes.length === 0) {
    throw new Error("OPENMAIL_API_KEYS is not set");
  }
  const server = createOpenMailServer({
    store: new ConfigCredentialStore(config),
    imap: createImapGateway(),
    apiKeyHashes,
  });
  const address = await listenOn(server, config.server.port, config.server.host);
  console.log(`OpenMail listening on http://${address.host}:${address.port}`);
}

async function listenMulti(config: AppConfig | undefined): Promise<void> {
  const masterKey = loadMasterKey(process.env.OPENMAIL_MASTER_KEY);
  const db = openDatabase(resolveDatabasePath(process.env));
  migrate(db);
  const allowInsecureLocalhost =
    process.env.OPENMAIL_ALLOW_INSECURE_LOCALHOST === "1" || config?.allowInsecureLocalhost === true;
  const server = createOpenMailServer({
    store: new SqliteCredentialStore(db, masterKey, { allowInsecureLocalhost }),
    imap: createImapGateway(),
    authenticate: (header) => authenticateDatabaseKey(db, header),
  });
  const host = config?.server.host ?? "127.0.0.1";
  const port = config?.server.port ?? 8080;
  const address = await listenOn(server, port, host);
  console.log(`OpenMail listening on http://${address.host}:${address.port}`);
}
