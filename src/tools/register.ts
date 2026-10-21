import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { UNTRUSTED_CONTENT_WARNING } from "../mail/constants.js";
import {
  listAccounts,
  listFolders,
  readMessage,
  readThread,
  searchMessages,
  type MailDeps,
} from "../mail/operations.js";
import type { ToolResult } from "../mail/result.js";
import {
  READ_ONLY_ANNOTATIONS,
  listAccountsInput,
  listFoldersInput,
  readMessageInput,
  readThreadInput,
  searchMessagesInput,
  toolDescription,
} from "./schemas.js";

export const DEFAULT_USER_ID = "default";

export function toCallToolResult(result: ToolResult<unknown>): CallToolResult {
  const payload = {
    content: [{ type: "text" as const, text: JSON.stringify(result) }],
    structuredContent: result as unknown as Record<string, unknown>,
  };
  return result.ok ? payload : { ...payload, isError: true };
}

export function createMailMcpServer(deps: MailDeps & { userId: string }): McpServer {
  const server = new McpServer(
    { name: "openmail", version: "0.1.0" },
    {
      instructions: `OpenMail exposes read-only IMAP tools. ${UNTRUSTED_CONTENT_WARNING}`,
    },
  );
  registerMailTools(server, deps);
  return server;
}

export function registerMailTools(server: McpServer, deps: MailDeps & { userId: string }): void {
  const userId = deps.userId;

  server.registerTool(
    "list_accounts",
    {
      title: "List accounts",
      description: toolDescription(
        "List mailbox accounts: id, label, email address, provider preset, and IMAP host. Passwords are never returned.",
      ),
      inputSchema: listAccountsInput,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async () => toCallToolResult(await listAccounts(deps.store, userId)),
  );

  server.registerTool(
    "list_folders",
    {
      title: "List folders",
      description: toolDescription(
        "List folders for an account, including special-use and message counts when the server provides them.",
      ),
      inputSchema: listFoldersInput,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (args) => toCallToolResult(await listFolders(deps, userId, args.account)),
  );

  server.registerTool(
    "search_messages",
    {
      title: "Search messages",
      description: toolDescription(
        "Search one folder, newest first. Returns an opaque next_cursor when more matches exist. Attachment filtering uses BODYSTRUCTURE.",
      ),
      inputSchema: searchMessagesInput,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (args) =>
      toCallToolResult(
        await searchMessages(deps, userId, args.account, {
          folder: args.folder,
          from: args.from,
          to: args.to,
          subject: args.subject,
          text: args.text,
          since: args.since,
          before: args.before,
          unread: args.unread,
          has_attachment: args.has_attachment,
          limit: args.limit,
          cursor: args.cursor,
        }),
      ),
  );

  server.registerTool(
    "read_message",
    {
      title: "Read message",
      description: toolDescription(
        "Read one message by UID without setting the \\Seen flag. HTML is converted to text when there is no text part. The body is capped at 20,000 characters. Attachments are listed without their bytes.",
      ),
      inputSchema: readMessageInput,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (args) => toCallToolResult(await readMessage(deps, userId, args.account, args.folder, args.uid)),
  );

  server.registerTool(
    "read_thread",
    {
      title: "Read thread",
      description: toolDescription(
        "Read the Message-ID, In-Reply-To, and References chain for one message, oldest first, without setting \\Seen. Combined body text is capped at 40,000 characters.",
      ),
      inputSchema: readThreadInput,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (args) => toCallToolResult(await readThread(deps, userId, args.account, args.folder, args.uid)),
  );
}
