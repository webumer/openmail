import { attachmentLimitsFromEnv, type AttachmentLimits } from "../config/runtime.js";
import { MailError } from "../errors.js";
import { ATTACHMENT_CHAR_CAP, UNTRUSTED_CONTENT_WARNING } from "./constants.js";
import { decodeCharset, decodeTransfer } from "./decode.js";
import { guard, parseSource, requireAccount, requireFolder, requireUid, type MailDeps } from "./operations.js";
import { extractPdfText } from "./pdf.js";
import { ok, type ToolResult } from "./result.js";
import type { MessageFetchQuery } from "./session.js";
import { baseType, estimatedSize, findPart, listAttachmentParts, type BodyNode } from "./structure.js";
import { capText, htmlToText } from "./text.js";

export interface AttachmentDeps extends MailDeps {
  /** Defaults to OPENMAIL_ATTACHMENT_MAX_BYTES / OPENMAIL_PDF_MAX_PAGES / OPENMAIL_PDF_TIMEOUT_MS. */
  attachmentLimits?: AttachmentLimits;
}

export interface AttachmentRequest {
  /** Position in read_message's attachment list, starting at 0. */
  index?: number;
  /** IMAP body part number from read_message. */
  part?: string;
  /** Return the decoded bytes as base64 when they fit the size cap. */
  include_base64?: boolean;
}

export type AttachmentKind = "text" | "pdf" | "email" | "binary";

export interface AttachmentData {
  uid: number;
  folder: string;
  index: number | null;
  part: string;
  filename: string | null;
  content_type: string;
  disposition: string | null;
  content_id: string | null;
  /** Decoded bytes when downloaded, otherwise estimated from BODYSTRUCTURE. */
  size: number | null;
  kind: AttachmentKind;
  /** Charset the text was decoded from (text attachments). */
  charset: string | null;
  /** Extracted text, capped at 20,000 characters. */
  text: string | null;
  /** Length of the whole extracted text before the cap. */
  text_length: number | null;
  /** PDF page count and pages whose text was read. */
  pages: number | null;
  pages_read: number | null;
  base64: string | null;
  /** Why no content was returned, or how to get it. */
  message: string | null;
}

const BODYSTRUCTURE_FETCH: MessageFetchQuery = { bodyStructure: true, size: true };
const PART_ID = /^[1-9]\d{0,5}(?:\.[1-9]\d{0,5}){0,15}$/;
/** HTML longer than this is cut before conversion so a huge page cannot stall the server. */
const HTML_INPUT_CAP = 2_000_000;
const TEXT_EXTENSIONS = /\.(txt|text|csv|tsv|json|xml|md|markdown|log|ics|vcf|yaml|yml)$/i;
const HTML_EXTENSIONS = /\.html?$/i;
const GENERIC_TYPES = new Set(["application/octet-stream", "binary/octet-stream", "application/unknown", "application/download"]);

interface Target {
  index: number | null;
  part: string;
  node: BodyNode;
  filename: string | null;
  section: string;
}

interface Downloaded {
  target: Target;
  bytes: Buffer | null;
  tooLarge: boolean;
}

export async function getAttachment(
  deps: AttachmentDeps,
  userId: string,
  accountId: string,
  folder: string,
  uid: number,
  request: AttachmentRequest,
): Promise<ToolResult<AttachmentData>> {
  return guard(async () => {
    const path = requireFolder(folder);
    requireUid(uid);
    validateSelector(request);
    const limits = deps.attachmentLimits ?? attachmentLimitsFromEnv();
    const account = await requireAccount(deps.store, userId, accountId);
    const downloaded = await deps.imap.withMailbox(account, path, async (session): Promise<Downloaded> => {
      const message = await session.fetchOne(uid, BODYSTRUCTURE_FETCH);
      if (!message) throw new MailError("not_found", `Message ${uid} was not found in ${path}`);
      const target = resolveTarget(message.bodyStructure, request);
      const kind = classify(target.node, target.filename);
      if (kind === "binary" && request.include_base64 !== true) return { target, bytes: null, tooLarge: false };
      const estimate = estimatedSize(target.node);
      if (estimate !== null && estimate > limits.maxBytes) return { target, bytes: null, tooLarge: true };
      const encodedLimit = encodedCap(limits.maxBytes, target.node.encoding);
      const raw = await session.fetchPart(uid, target.section, encodedLimit + 1);
      if (!raw) throw new MailError("not_found", `Part ${target.part} of message ${uid} could not be fetched`);
      if (raw.length > encodedLimit) throw tooLargeError(limits.maxBytes);
      const bytes = decodeTransfer(raw, target.node.encoding);
      if (bytes.length > limits.maxBytes) throw tooLargeError(limits.maxBytes);
      return { target, bytes, tooLarge: false };
    });
    return describe(downloaded, path, uid, request, limits);
  });
}

function validateSelector(request: AttachmentRequest): void {
  if (request.index === undefined && request.part === undefined) {
    throw new MailError("invalid_argument", "Pass index or part from the attachments listed by read_message");
  }
  if (request.index !== undefined && (!Number.isSafeInteger(request.index) || request.index < 0)) {
    throw new MailError("invalid_argument", "index must be a non-negative integer");
  }
  if (request.part !== undefined && !PART_ID.test(request.part)) {
    throw new MailError("invalid_argument", "part must be a MIME part number such as 2 or 1.2, as listed by read_message");
  }
}

function resolveTarget(root: BodyNode | null, request: AttachmentRequest): Target {
  if (!root) throw new MailError("not_found", "The message structure is unavailable");
  const listed = listAttachmentParts(root);
  const singlePart = !root.childNodes?.length;
  const sectionOf = (part: string) => (singlePart && part === "1" ? "TEXT" : part);
  if (request.index !== undefined) {
    const item = listed[request.index];
    if (!item) {
      throw new MailError("not_found", `Attachment index ${request.index} was not found; the message has ${listed.length} attachment${listed.length === 1 ? "" : "s"}`);
    }
    if (request.part !== undefined && request.part !== item.part) {
      throw new MailError("invalid_argument", `index ${request.index} is part ${item.part}, not part ${request.part}; pass one of them`);
    }
    return { index: item.index, part: item.part, node: item.node, filename: item.filename, section: sectionOf(item.part) };
  }
  const part = request.part!;
  const item = listed.find((candidate) => candidate.part === part);
  if (item) return { index: item.index, part, node: item.node, filename: item.filename, section: sectionOf(part) };
  const node = findPart(root, part);
  if (!node) throw new MailError("not_found", `Part ${part} was not found in the message`);
  return { index: null, part, node, filename: filenameOf(node), section: sectionOf(part) };
}

function filenameOf(node: BodyNode): string | null {
  return node.dispositionParameters?.filename || node.parameters?.name || null;
}

export function classify(node: Pick<BodyNode, "type">, filename: string | null): AttachmentKind {
  const type = baseType(node.type);
  const name = filename ?? "";
  if (type === "application/pdf" || type === "application/x-pdf") return "pdf";
  if (type === "message/rfc822") return "email";
  if (isTextType(type)) return "text";
  if (GENERIC_TYPES.has(type)) {
    if (/\.pdf$/i.test(name)) return "pdf";
    if (TEXT_EXTENSIONS.test(name) || HTML_EXTENSIONS.test(name)) return "text";
  }
  return "binary";
}

function isTextType(type: string): boolean {
  return type.startsWith("text/") ||
    ["application/json", "application/xml", "application/csv", "application/x-ndjson", "application/ld+json"].includes(type) ||
    type.endsWith("+json") || type.endsWith("+xml");
}

function isHtml(type: string, filename: string | null): boolean {
  return type === "text/html" || type === "application/xhtml+xml" || (GENERIC_TYPES.has(type) && HTML_EXTENSIONS.test(filename ?? ""));
}

/** Most encoded bytes that can decode to `maxBytes`. */
function encodedCap(maxBytes: number, encoding: string | null | undefined): number {
  const value = (encoding ?? "").toLowerCase();
  if (value === "base64") return Math.ceil((maxBytes * 4) / 3 * 78 / 76) + 4_096;
  if (value === "quoted-printable") return maxBytes * 3;
  return maxBytes;
}

function tooLargeError(maxBytes: number): MailError {
  return new MailError("too_large", `The attachment is larger than the ${formatBytes(maxBytes)} limit, so it was not downloaded.`);
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${Math.round((bytes / (1024 * 1024)) * 10) / 10} MB`;
  return `${Math.round(bytes / 1024)} KB`;
}

async function describe(
  downloaded: Downloaded,
  folder: string,
  uid: number,
  request: AttachmentRequest,
  limits: AttachmentLimits,
): Promise<ToolResult<AttachmentData>> {
  const { target, bytes } = downloaded;
  const node = target.node;
  const contentType = baseType(node.type);
  const kind = classify(node, target.filename);
  const warnings = [UNTRUSTED_CONTENT_WARNING];
  let truncated = false;
  const data: AttachmentData = {
    uid,
    folder,
    index: target.index,
    part: target.part,
    filename: target.filename,
    content_type: contentType,
    disposition: node.disposition ? node.disposition.toLowerCase() : null,
    content_id: node.id ? node.id.replace(/^<|>$/g, "").trim() || null : null,
    size: bytes ? bytes.length : estimatedSize(node),
    kind,
    charset: null,
    text: null,
    text_length: null,
    pages: null,
    pages_read: null,
    base64: null,
    message: null,
  };

  if (downloaded.tooLarge) {
    data.message = `The attachment is about ${formatBytes(data.size ?? 0)}, over the ${formatBytes(limits.maxBytes)} limit, so it was not downloaded. Only its details are shown.`;
    return ok(data, { warnings });
  }
  if (!bytes) {
    data.message = `${contentType} files are not converted to text. Call get_attachment again with include_base64=true to get the file as base64 (up to ${formatBytes(limits.maxBytes)}).`;
    return ok(data, { warnings });
  }

  const setText = (text: string, total = text.length) => {
    const capped = capText(text, ATTACHMENT_CHAR_CAP);
    data.text = capped.text;
    data.text_length = total;
    if (capped.truncated || total > capped.text.length) {
      truncated = true;
      warnings.push(`Attachment text truncated to ${ATTACHMENT_CHAR_CAP} characters of ${total}.`);
    }
  };

  if (kind === "text") {
    const decoded = decodeCharset(bytes, node.parameters?.charset);
    data.charset = decoded.charset;
    if (decoded.unknownCharset) warnings.push("The attachment's charset is not supported; it was read as UTF-8.");
    if (isHtml(contentType, target.filename)) {
      const html = decoded.text.length > HTML_INPUT_CAP ? decoded.text.slice(0, HTML_INPUT_CAP) : decoded.text;
      if (html.length < decoded.text.length) {
        truncated = true;
        warnings.push("The HTML attachment is very long; only its beginning was converted to text.");
      }
      setText(htmlToText(html));
    } else {
      setText(decoded.text);
    }
  } else if (kind === "pdf") {
    const pdf = await extractPdfText(new Uint8Array(bytes), {
      maxPages: limits.pdfMaxPages,
      timeoutMs: limits.pdfTimeoutMs,
      maxChars: ATTACHMENT_CHAR_CAP,
    });
    data.pages = pdf.pages;
    data.pages_read = pdf.pagesRead;
    setText(pdf.text, pdf.chars);
    if (pdf.pagesRead < pdf.pages) {
      truncated = true;
      warnings.push(`Only the first ${pdf.pagesRead} of ${pdf.pages} PDF pages were read.`);
    }
    if (pdf.chars === 0) data.message = "The PDF has no extractable text; it may be a scanned image.";
  } else if (kind === "email") {
    const parsed = await parseSource(bytes);
    const from = parsed.headers.from.map((address) => address.address ?? address.name ?? "").filter(Boolean).join(", ");
    const header = [`Subject: ${parsed.headers.subject ?? ""}`, `From: ${from}`, `Date: ${parsed.headers.date?.utc ?? ""}`].join("\n");
    setText(`${header}\n\n${parsed.text}`);
  }

  if (request.include_base64 === true) data.base64 = bytes.toString("base64");
  return ok(data, { truncated, warnings });
}
