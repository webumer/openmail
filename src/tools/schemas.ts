import { z } from "zod";
import { UNTRUSTED_CONTENT_WARNING } from "../mail/constants.js";

export function toolDescription(action: string): string {
  return `${action} ${UNTRUSTED_CONTENT_WARNING}`;
}

const accountId = z.string().min(1).describe("Account id from list_accounts");

export const listAccountsInput = z.object({}).strict();

export const listFoldersInput = z
  .object({
    account: accountId,
  })
  .strict();

export const searchMessagesInput = z
  .object({
    account: accountId,
    folder: z.string().min(1).default("INBOX").describe("Mailbox path. Defaults to INBOX."),
    from: z.string().min(1).optional().describe("From address substring"),
    to: z.string().min(1).optional().describe("To address substring"),
    subject: z.string().min(1).optional().describe("Subject substring"),
    text: z.string().min(1).optional().describe("Substring matched against the message text"),
    since: z.string().min(1).optional().describe("Include messages on or after this date (YYYY-MM-DD or ISO-8601)"),
    before: z.string().min(1).optional().describe("Include messages before this date (YYYY-MM-DD or ISO-8601)"),
    unread: z.boolean().optional().describe("When true, only messages without the \\Seen flag"),
    has_attachment: z.boolean().optional().describe("Filter by whether the message has an attachment"),
    limit: z.number().int().min(1).max(50).default(20).describe("Page size, from 1 to 50. Defaults to 20."),
    cursor: z.string().min(1).optional().describe("Opaque cursor from a previous search_messages result"),
  })
  .strict();

export const readMessageInput = z
  .object({
    account: accountId,
    folder: z.string().min(1).describe("Mailbox path"),
    uid: z.number().int().positive().describe("IMAP UID"),
  })
  .strict();

export const readThreadInput = readMessageInput;

export const READ_ONLY_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;
