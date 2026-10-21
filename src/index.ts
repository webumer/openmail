import { pathToFileURL } from "node:url";

export { loadConfig, parseConfig, type AccountConfig, type AppConfig, type ServerConfig } from "./config/index.js";
export {
  ConfigCredentialStore,
  type AccountCredentials,
  type AccountSummary,
  type CredentialStore,
} from "./store/index.js";
export {
  createImapGateway,
  listAccounts,
  listFolders,
  readMessage,
  readThread,
  searchMessages,
  type ImapGateway,
  type ToolResult,
} from "./mail/index.js";

const invoked = process.argv[1];
if (invoked && import.meta.url === pathToFileURL(invoked).href) {
  console.log(
    "OpenMail mail core is ready. The streamable-HTTP MCP server is not started by this entrypoint yet.",
  );
}
