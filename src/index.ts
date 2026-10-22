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
import { authenticateDatabaseKey, BODY_LIMIT_BYTES, createOpenMailServer, hashApiKeys, listenOn } from "./server/index.js";
import { apiKeys, mailAccounts, users } from "./services/index.js";
import {
  ConfigCredentialStore,
  SqliteCredentialStore,
  type AccountCredentials,
  type AccountSummary,
  type CredentialStore,
} from "./store/index.js";
import { createWebHandler, resolveSecureCookies } from "./web/index.js";
import { parseInsecureImapHosts } from "./mail/tls.js";
import { demoConfigFromEnv, reseedIntervalFromEnv, startDemoSeeder } from "./demo/seed.js";
import { bearerChallenge, createDocumentFetcher, createOAuthHandler, deriveOAuthConfig } from "./oauth/index.js";

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
export { authenticateDatabaseKey, BODY_LIMIT_BYTES, createOpenMailServer, hashApiKeys, listenOn };
export { createWebHandler, resolveSecureCookies };

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
  const publicUrl = process.env.OPENMAIL_PUBLIC_URL?.trim() || undefined;
  const trustProxy = process.env.OPENMAIL_TRUST_PROXY === "1";
  const server = createOpenMailServer({
    store: new ConfigCredentialStore(config),
    imap: createImapGateway(),
    apiKeyHashes,
    security: {
      ...(publicUrl ? { publicUrl } : {}),
      trustProxy,
    },
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
  const insecureImapHosts = parseInsecureImapHosts(process.env.OPENMAIL_INSECURE_IMAP_HOSTS);
  const demo = demoConfigFromEnv(process.env, insecureImapHosts);
  if (demo) startDemoSeeder(demo, reseedIntervalFromEnv(process.env));
  const publicUrl = process.env.OPENMAIL_PUBLIC_URL?.trim() || undefined;
  const trustProxy = process.env.OPENMAIL_TRUST_PROXY === "1";
  const secureCookies = resolveSecureCookies(process.env);
  const imap = createImapGateway();
  const web = createWebHandler({
    db,
    masterKey,
    imap,
    ...(publicUrl ? { publicUrl } : {}),
    trustProxy,
    allowInsecureLocalhost,
    secureCookies,
    bodyLimit: BODY_LIMIT_BYTES,
  });
  // OAuth 2.1 sign-in (Claude, ChatGPT, Muse...) runs only with an https public URL.
  const oauthConfig = deriveOAuthConfig(publicUrl);
  const oauth = oauthConfig
    ? createOAuthHandler({
        db,
        config: oauthConfig,
        fetcher: createDocumentFetcher(),
        trustProxy,
        bodyLimit: BODY_LIMIT_BYTES,
        ...(process.env.OPENMAIL_OPENAI_CHALLENGE ? { openaiChallenge: process.env.OPENMAIL_OPENAI_CHALLENGE } : {}),
      })
    : undefined;
  const server = createOpenMailServer({
    store: new SqliteCredentialStore(db, masterKey, { allowInsecureLocalhost, insecureImapHosts }),
    imap,
    authenticate: (header) => authenticateDatabaseKey(db, header, oauthConfig?.resource),
    web: oauth ? async (req, res) => (await oauth(req, res)) || (await web(req, res)) : web,
    ...(oauthConfig ? { challenge: (invalid: boolean) => bearerChallenge(oauthConfig, invalid) } : {}),
    security: {
      ...(publicUrl ? { publicUrl } : {}),
      trustProxy,
    },
  });
  const host = config?.server.host ?? "127.0.0.1";
  const port = config?.server.port ?? 8080;
  const address = await listenOn(server, port, host);
  console.log(`OpenMail listening on http://${address.host}:${address.port}`);
}
