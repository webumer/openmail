import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { setupRequired } from "../mail/setup.js";
import { durationBucket, recordMetric, toolOutcome, type MetricRecorder } from "../services/metrics.js";
import { fail } from "../mail/result.js";
import { MailError } from "../errors.js";
import { VERSION } from "../version.js";
import { UNTRUSTED_CONTENT_WARNING } from "../mail/constants.js";
import {
  listAccounts,
  listFolders,
  readMessage,
  readThread,
  searchMessages,
  type MailDeps,
} from "../mail/operations.js";
import { sendMessage, type SendDeps } from "../mail/send.js";
import type { ToolResult } from "../mail/result.js";
import {
  READ_ONLY_ANNOTATIONS,
  SEND_ANNOTATIONS,
  SEND_MESSAGE_DESCRIPTION,
  listAccountsInput,
  listFoldersInput,
  readMessageInput,
  readThreadInput,
  searchMessagesInput,
  sendMessageInput,
  toolDescription,
} from "./schemas.js";

export const DEFAULT_USER_ID = "default";

export function toCallToolResult(result: ToolResult<unknown>): CallToolResult {
  const payload = {
    content: [{ type: "text" as const, text: JSON.stringify(result) }],
    structuredContent: result as unknown as Record<string, unknown>,
  };
  return result.ok ? { ...payload, isError: false } : { ...payload, isError: true };
}

export interface MailServerDeps extends MailDeps, Omit<SendDeps, "store" | "imap"> {
  userId: string;
  metrics?: MetricRecorder;
}

export function createMailMcpServer(deps: MailServerDeps): McpServer {
  const server = new McpServer(
    { name: "openmail", version: VERSION },
    {
      instructions: `OpenMail reads mail (read-only, never marks as read) and can send email only when the user enabled sending for that mailbox and approved each message. ${UNTRUSTED_CONTENT_WARNING}`,
    },
  );
  registerMailTools(server, deps);
  return server;
}

export function registerMailTools(server: McpServer, deps: MailServerDeps): void {
  const userId = deps.userId;
  const call = async (name: string, run: () => Promise<ToolResult<unknown>>): Promise<CallToolResult> => {
    const started = performance.now();
    let result: ToolResult<unknown>;
    try {
      const accounts = await deps.store.listAccounts(userId);
      result = accounts.length === 0 ? setupRequired(name, deps.publicUrl) : await run();
    } catch (err) {
      result = err instanceof MailError ? fail(err.code, err.message) : fail("internal_error", "Unexpected error");
    }
    recordMetric(deps.metrics, {
      kind: "tool_call",
      name,
      outcome: result.ok ? (result.setup_required ? "setup_required" : "ok") : toolOutcome(result.error.code),
      bucket: durationBucket(performance.now() - started),
    });
    return toCallToolResult(result);
  };

  server.registerTool(
    "list_accounts",
    {
      title: "List accounts",
      description: toolDescription(
        "List mailbox accounts: id, label, email address, provider preset, IMAP host, and whether sending is enabled. Passwords are never returned.",
      ),
      inputSchema: listAccountsInput,
      annotations: { ...READ_ONLY_ANNOTATIONS, title: "List accounts" },
    },
    async () => call("list_accounts", () => listAccounts(deps.store, userId, { canSend: deps.canSend })),
  );

  server.registerTool(
    "list_folders",
    {
      title: "List folders",
      description: toolDescription(
        "List folders for an account, including special-use and message counts when the server provides them.",
      ),
      inputSchema: listFoldersInput,
      annotations: { ...READ_ONLY_ANNOTATIONS, title: "List folders" },
    },
    async (args) => call("list_folders", () => listFolders(deps, userId, args.account)),
  );

  server.registerTool(
    "search_messages",
    {
      title: "Search messages",
      description: toolDescription(
        "Search one folder, newest first. Returns an opaque next_cursor when more matches exist. Attachment filtering uses BODYSTRUCTURE.",
      ),
      inputSchema: searchMessagesInput,
      annotations: { ...READ_ONLY_ANNOTATIONS, title: "Search messages" },
    },
    async (args) =>
      call("search_messages", () =>
        searchMessages(deps, userId, args.account, {
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
        "Read one message by UID without setting the \\Seen flag. Headers include from, to, cc, and reply_to. HTML is converted to text when there is no text part. The body is capped at 20,000 characters. Attachments are listed by name without their bytes.",
      ),
      inputSchema: readMessageInput,
      annotations: { ...READ_ONLY_ANNOTATIONS, title: "Read message" },
    },
    async (args) => call("read_message", () => readMessage(deps, userId, args.account, args.folder, args.uid)),
  );

  server.registerTool(
    "read_thread",
    {
      title: "Read thread",
      description: toolDescription(
        "Read the Message-ID, In-Reply-To, and References chain for one message, oldest first, without setting \\Seen. Combined body text is capped at 40,000 characters.",
      ),
      inputSchema: readThreadInput,
      annotations: { ...READ_ONLY_ANNOTATIONS, title: "Read thread" },
    },
    async (args) => call("read_thread", () => readThread(deps, userId, args.account, args.folder, args.uid)),
  );

  server.registerTool(
    "send_message",
    {
      title: "Send email",
      description: toolDescription(SEND_MESSAGE_DESCRIPTION),
      inputSchema: sendMessageInput,
      annotations: { ...SEND_ANNOTATIONS, title: "Send email" },
    },
    async (args) =>
      call("send_message", () =>
        sendMessage(deps, userId, {
          account: args.account,
          to: args.to,
          ...(args.cc ? { cc: args.cc } : {}),
          ...(args.bcc ? { bcc: args.bcc } : {}),
          ...(args.subject !== undefined ? { subject: args.subject } : {}),
          body: args.body,
          ...(args.from_name !== undefined ? { from_name: args.from_name } : {}),
          ...(args.reply_to
            ? {
                reply_to: {
                  folder: args.reply_to.folder,
                  uid: args.reply_to.uid,
                  mode: args.reply_to.mode,
                  quote_original: args.reply_to.quote_original,
                  include_attachments: args.reply_to.include_attachments,
                },
              }
            : {}),
          user_confirmed: args.user_confirmed,
        }),
      ),
  );
}
