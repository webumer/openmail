import { randomUUID } from "node:crypto";
import { simpleParser } from "mailparser";
import MailComposer from "nodemailer/lib/mail-composer/index.js";
import addressparser from "nodemailer/lib/addressparser/index.js";
import { MailError } from "../errors.js";
import { parseMessage, type ParsedMessageContent } from "./parse-message.js";

export const DEFAULT_MAX_RECIPIENTS = 20;
export const SUBJECT_MAX = 300;
export const BODY_MAX = 100_000;
export const HTML_MAX = 200_000;
export const FROM_NAME_MAX = 100;
export const QUOTE_CHAR_CAP = 20_000;
export const FORWARD_ATTACHMENT_CAP_BYTES = 15 * 1024 * 1024;
export const REFERENCES_CAP = 20;

const CONTROL = /[\u0000-\u001f\u007f]/;
const ADDR_SPEC =
  /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;
const RE_PREFIX = /^(?:re|aw|sv)\s*:\s*/i;
const FWD_PREFIX = /^fwd\s*:\s*/i;

export interface OriginalMail {
  subject: string | null;
  from: string[];
  to: string[];
  cc: string[];
  replyTo: string[];
  dateLabel: string;
  messageId: string | null;
  references: string[];
  text: string;
  attachments: { filename: string; contentType: string; content: Buffer }[];
}

export function assertHeaderText(value: string, label: string): string {
  if (CONTROL.test(value)) {
    throw new MailError("invalid_argument", `${label} contains invalid characters`);
  }
  return value;
}

/** One mailbox, no groups, no comments, no header injection. Returns the addr-spec. */
export function parseOneAddress(raw: string): string {
  if (typeof raw !== "string") throw new MailError("invalid_argument", "Email address is invalid");
  const value = raw.trim();
  assertHeaderText(value, "Email address");
  if (value.length === 0 || value.length > 320 || value.includes("(") || value.includes(")") || value.includes(",")) {
    throw new MailError("invalid_argument", "Each recipient must be a single email address");
  }
  const parsed = addressparser(value);
  const entry = parsed.length === 1 ? parsed[0] : undefined;
  if (!entry || entry.group || !entry.address) {
    throw new MailError("invalid_argument", "Each recipient must be a single email address");
  }
  const address = entry.address.trim();
  if (address.length > 254 || !ADDR_SPEC.test(address) || CONTROL.test(address)) {
    throw new MailError("invalid_argument", "Email address is invalid");
  }
  return address;
}

export function dedupeAddresses(addresses: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const address of addresses) {
    const key = address.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(address);
  }
  return out;
}

export function replySubject(original: string): string {
  let rest = original.trim();
  while (RE_PREFIX.test(rest)) rest = rest.replace(RE_PREFIX, "");
  return `Re: ${rest}`;
}

export function forwardSubject(original: string): string {
  const trimmed = original.trim();
  if (FWD_PREFIX.test(trimmed)) return trimmed;
  return `Fwd: ${trimmed}`;
}

export function capReferences(existing: readonly string[], messageId: string | null): string[] {
  const ids: string[] = [];
  for (const item of existing) {
    const id = normalizeMessageId(item);
    if (id) ids.push(id);
  }
  const current = messageId ? normalizeMessageId(messageId) : null;
  if (current && ids.at(-1)?.toLowerCase() !== current.toLowerCase()) ids.push(current);
  return ids.slice(-REFERENCES_CAP);
}

export function quoteOriginal(dateLabel: string, fromLabel: string, text: string): string {
  const capped = text.length > QUOTE_CHAR_CAP ? text.slice(0, QUOTE_CHAR_CAP) : text;
  const quoted = capped.split(/\r?\n/).map((line) => `> ${line}`).join("\n");
  return `\n\nOn ${dateLabel}, ${fromLabel} wrote:\n${quoted}`;
}

export function forwardOriginal(original: OriginalMail): string {
  const text = original.text.length > QUOTE_CHAR_CAP ? original.text.slice(0, QUOTE_CHAR_CAP) : original.text;
  return [
    "",
    "",
    "---------- Forwarded message ---------",
    `From: ${original.from.join(", ") || "unknown"}`,
    `Date: ${original.dateLabel}`,
    `Subject: ${original.subject ?? ""}`,
    `To: ${original.to.join(", ")}`,
    "",
    text,
  ].join("\n");
}

export function resolveRecipients(input: {
  mode: "new" | "reply" | "reply_all" | "forward";
  accountEmail: string;
  to?: string[];
  cc?: string[];
  bcc?: string[];
  original?: Pick<OriginalMail, "from" | "to" | "cc" | "replyTo">;
  maxRecipients: number;
}): { to: string[]; cc: string[]; bcc: string[] } {
  let to = input.to === undefined ? undefined : dedupeAddresses(input.to.map(parseOneAddress));
  let cc = input.cc === undefined ? undefined : dedupeAddresses(input.cc.map(parseOneAddress));
  const bcc = input.bcc === undefined ? [] : dedupeAddresses(input.bcc.map(parseOneAddress));
  if ((input.mode === "reply" || input.mode === "reply_all") && (!to || to.length === 0)) {
    const source = input.original && input.original.replyTo.length > 0 ? input.original.replyTo : (input.original?.from ?? []);
    to = dedupeAddresses(source.map(parseOneAddress));
  }
  if (input.mode === "reply_all" && cc === undefined && input.original) {
    const own = input.accountEmail.toLowerCase();
    const already = new Set((to ?? []).map((address) => address.toLowerCase()));
    cc = dedupeAddresses(
      [...input.original.to, ...input.original.cc]
        .map(parseOneAddress)
        .filter((address) => address.toLowerCase() !== own && !already.has(address.toLowerCase())),
    );
  }
  const toList = dropSeen(to ?? [], new Set());
  const ccList = dropSeen(cc ?? [], new Set(toList.map((address) => address.toLowerCase())));
  const seen = new Set([...toList, ...ccList].map((address) => address.toLowerCase()));
  const bccList = dropSeen(bcc, seen);
  const total = toList.length + ccList.length + bccList.length;
  if (total < 1) throw new MailError("invalid_argument", "Enter at least one recipient");
  if (total > input.maxRecipients) {
    throw new MailError("invalid_argument", `A message can have at most ${input.maxRecipients} recipients`);
  }
  return { to: toList, cc: ccList, bcc: bccList };
}

export async function originalFromSource(source: Buffer): Promise<OriginalMail> {
  const parsed = await parseMessage(source);
  const raw = await simpleParser(source);
  const attachments = (raw.attachments ?? [])
    .filter((item) => item.content && item.contentDisposition !== "inline")
    .map((item) => ({
      filename: item.filename?.trim() || "attachment",
      contentType: item.contentType || "application/octet-stream",
      content: item.content,
    }));
  return {
    subject: parsed.headers.subject,
    from: addressesOf(parsed, "from"),
    to: addressesOf(parsed, "to"),
    cc: addressesOf(parsed, "cc"),
    replyTo: addressesOf(parsed, "reply_to"),
    dateLabel: parsed.headers.date?.original ?? "an unknown date",
    messageId: parsed.headers.message_id,
    references: parsed.headers.references,
    text: parsed.text,
    attachments,
  };
}

export async function buildRawMessage(input: {
  accountEmail: string;
  fromName?: string;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  text: string;
  html?: string;
  inReplyTo?: string;
  references?: string[];
  attachments?: { filename: string; contentType: string; content: Buffer }[];
}): Promise<{ raw: Buffer; messageId: string }> {
  const domain = input.accountEmail.split("@")[1]?.trim().toLowerCase() || "localhost";
  const messageId = `<${randomUUID()}@${domain}>`;
  const from = input.fromName ? { name: input.fromName, address: input.accountEmail } : input.accountEmail;
  const composer = new MailComposer({
    from,
    to: input.to,
    ...(input.cc.length > 0 ? { cc: input.cc } : {}),
    ...(input.bcc.length > 0 ? { bcc: input.bcc } : {}),
    subject: input.subject,
    text: input.text,
    ...(input.html !== undefined ? { html: input.html } : {}),
    messageId,
    date: new Date(),
    xMailer: "OpenMail",
    ...(input.inReplyTo ? { inReplyTo: input.inReplyTo } : {}),
    ...(input.references && input.references.length > 0 ? { references: input.references } : {}),
    ...(input.attachments && input.attachments.length > 0
      ? {
          attachments: input.attachments.map((item) => ({
            filename: item.filename,
            contentType: item.contentType,
            content: item.content,
          })),
        }
      : {}),
    disableFileAccess: true,
    disableUrlAccess: true,
  });
  const raw = await composer.compile().build();
  return { raw, messageId };
}

function addressesOf(parsed: ParsedMessageContent, field: "from" | "to" | "cc" | "reply_to"): string[] {
  return parsed.headers[field].map((item) => item.address).filter((address) => address.trim() !== "");
}

function normalizeMessageId(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed || CONTROL.test(trimmed)) return null;
  const bare = trimmed.replace(/^<|>$/g, "");
  if (!bare || /\s/.test(bare)) return null;
  return `<${bare}>`;
}

function dropSeen(addresses: readonly string[], seen: Set<string>): string[] {
  const out: string[] = [];
  for (const address of addresses) {
    const key = address.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(address);
  }
  return out;
}
