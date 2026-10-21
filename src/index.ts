import { pathToFileURL } from "node:url";
import { loadConfig, parseConfig, type AccountConfig, type AppConfig, type ServerConfig } from "./config/index.js";
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
import { createOpenMailServer, hashApiKeys, listenOn } from "./server/index.js";
import { ConfigCredentialStore, type AccountCredentials, type AccountSummary, type CredentialStore } from "./store/index.js";

export { loadConfig, parseConfig, type AccountConfig, type AppConfig, type ServerConfig };
export { ConfigCredentialStore, type AccountCredentials, type AccountSummary, type CredentialStore };
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
export { createOpenMailServer, hashApiKeys, listenOn };

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
  const config = loadConfig(configPath);
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
