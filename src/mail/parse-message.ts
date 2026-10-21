import { simpleParser, type ParsedMail, type AddressObject } from "mailparser";
import { envelopeAddresses, type MailAddress } from "./addresses.js";
import { headerValue, normalizeDate, type NormalizedDate } from "./dates.js";
import { selectMessageText } from "./text.js";

export interface AttachmentInfo {
  filename: string | null;
  content_type: string;
  size: number | null;
  content_id: string | null;
}

export interface MessageHeaders {
  subject: string | null;
  from: MailAddress[];
  to: MailAddress[];
  cc: MailAddress[];
  reply_to: MailAddress[];
  date: NormalizedDate | null;
  message_id: string | null;
  in_reply_to: string | null;
  references: string[];
}

export interface ParsedMessageContent {
  headers: MessageHeaders;
  text: string;
  attachments: AttachmentInfo[];
}

export async function parseMessage(source: Buffer | string): Promise<ParsedMessageContent> {
  const parsed = await simpleParser(source, { skipHtmlToText: true });
  return {
    headers: headersFromParsed(parsed),
    text: selectMessageText(parsed.text, parsed.html),
    attachments: (parsed.attachments ?? []).map((attachment) => ({
      filename: attachment.filename ?? null,
      content_type: attachment.contentType,
      size: typeof attachment.size === "number" ? attachment.size : null,
      content_id: attachment.cid ?? stripBrackets(attachment.contentId),
    })),
  };
}

function headersFromParsed(parsed: ParsedMail): MessageHeaders {
  const rawDate = rawHeaderLine(parsed, "date");
  const date = rawDate ? normalizeDate(rawDate, rawDate) : parsed.date ? normalizeDate(parsed.date) : null;
  return {
    subject: parsed.subject ?? null,
    from: addressList(parsed.from),
    to: addressList(parsed.to),
    cc: addressList(parsed.cc),
    reply_to: addressList(parsed.replyTo),
    date,
    message_id: parsed.messageId ?? null,
    in_reply_to: parsed.inReplyTo ?? null,
    references: referenceList(parsed.references),
  };
}

function addressList(value: AddressObject | AddressObject[] | undefined): MailAddress[] {
  if (!value) return [];
  const objects = Array.isArray(value) ? value : [value];
  return objects.flatMap((object) => envelopeAddresses(object.value));
}

function referenceList(value: string | string[] | undefined): string[] {
  if (!value) return [];
  const list = Array.isArray(value) ? value : [value];
  return list.map((item) => item.trim()).filter((item) => item.length > 0);
}

function rawHeaderLine(parsed: ParsedMail, name: string): string | null {
  const block = parsed.headerLines.map((line) => line.line).join("\r\n");
  return headerValue(block, name);
}

function stripBrackets(value: string | undefined): string | null {
  if (!value) return null;
  const stripped = value.replace(/^<|>$/g, "").trim();
  return stripped || null;
}
