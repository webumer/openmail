import { MailError, scrubSecret, toMailError, toSmtpError } from "../errors.js";
import type { AccountCredentials, CredentialStore } from "../store/types.js";
import { sendLimitsFromEnv, type SendLimits, type SendRecorder } from "../services/send-log.js";
import { MESSAGE_SOURCE_CAP_BYTES } from "./constants.js";
import {
  BODY_MAX,
  FROM_NAME_MAX,
  SUBJECT_MAX,
  assertHeaderText,
  buildRawMessage,
  capReferences,
  forwardOriginal,
  forwardSubject,
  normalizeMessageId,
  originalFromSource,
  parseOneAddress,
  quoteOriginal,
  replySubject,
  resolveRecipients,
  stripControls,
  takeForwardAttachments,
  type OriginalMail,
} from "./compose.js";
import type { ImapGateway } from "./imap-gateway.js";
import { fail, ok, type ToolResult } from "./result.js";
import type { ListedMailbox, MessageFetchQuery } from "./session.js";
import { withUserSendLock } from "./send-lock.js";
import type { SmtpGateway } from "./smtp-gateway.js";

const ORIGINAL_FETCH: MessageFetchQuery = {
  source: { maxLength: MESSAGE_SOURCE_CAP_BYTES },
  envelope: true,
  flags: true,
  bodyStructure: true,
  internalDate: true,
  size: true,
  headers: ["date", "message-id", "in-reply-to", "references"],
};

const SENT_NAMES = ["sent", "sent items", "sent messages", "inbox.sent"];

export interface SendDeps {
  store: CredentialStore;
  imap: ImapGateway;
  smtp: SmtpGateway;
  sends: SendRecorder;
  canSend: boolean;
  via: string;
  publicUrl?: string;
  limits?: SendLimits;
}

export interface ReplyTarget {
  folder: string;
  uid: number;
  mode: "reply" | "forward";
  quote_original: boolean;
  include_attachments: boolean;
}

export interface SendInput {
  account: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject?: string;
  body: string;
  from_name?: string;
  reply_to?: ReplyTarget;
  user_confirmed: true;
}

export interface SendData {
  sent: true;
  message_id: string;
  account: string;
  from: string;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  in_reply_to: string | null;
  body_chars: number;
  sent_copy: { saved: boolean; folder: string | null };
  warnings: string[];
}

export async function sendMessage(deps: SendDeps, userId: string, input: SendInput): Promise<ToolResult<SendData>> {
  try {
    if (typeof userId !== "string" || userId.trim() === "") {
      throw new MailError("invalid_argument", "userId is required");
    }
    if (input.user_confirmed !== true) {
      throw new MailError("invalid_argument", "user_confirmed must be true");
    }
    const limits = deps.limits ?? sendLimitsFromEnv();
    const prepared = prepareText(input, limits.maxRecipients);
    if (!deps.canSend) {
      return fail(
        "send_not_permitted",
        `This connection is read-only. Reconnect OpenMail and allow sending, or use an API key with send permission (dashboard: ${dashboardUrl(deps.publicUrl)}).`,
      );
    }
    const account = await deps.store.getAccount(userId, input.account);
    if (!account) return fail("not_found", `Account ${input.account} was not found`);
    if (!account.sendEnabled) {
      return fail(
        "sending_disabled",
        `Sending is turned off for this mailbox. Turn on 'Allow sending' for it at ${dashboardUrl(deps.publicUrl)}.`,
      );
    }
    return await withUserSendLock(userId, () => deliver(deps, userId, account, prepared, limits));
  } catch (err) {
    if (err instanceof MailError) return fail(err.code, err.message);
    return fail("internal_error", "Unexpected error");
  }
}

interface PreparedText {
  accountId: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject?: string;
  body: string;
  fromName?: string;
  replyTo?: ReplyTarget;
}

async function deliver(
  deps: SendDeps,
  userId: string,
  account: AccountCredentials,
  prepared: PreparedText,
  limits: SendLimits,
): Promise<ToolResult<SendData>> {
  const warnings: string[] = [];
  const mode = prepared.replyTo?.mode ?? "new";
  const reserved = deps.sends.reserve(
    {
      userId,
      accountId: account.id,
      accountLabel: clipLabel(account.label),
      recipients: suppliedCount(prepared),
      via: clipLabel(deps.via),
    },
    limits,
  );
  if (!reserved.ok) {
    return fail("rate_limited", `Sending is rate limited. Try again after ${reserved.retryAt}.`);
  }
  try {
    const original = prepared.replyTo ? await loadOriginal(deps, account, prepared.replyTo) : undefined;
    const recipients = resolveRecipients({
      to: prepared.to,
      ...(prepared.cc ? { cc: prepared.cc } : {}),
      ...(prepared.bcc ? { bcc: prepared.bcc } : {}),
      maxRecipients: limits.maxRecipients,
    });
    const subject = chooseSubject(prepared.subject, mode, original);
    let text = prepared.body;
    if (prepared.replyTo?.quote_original !== false && original && mode !== "forward") {
      text += quoteOriginal(original.dateLabel, original.from.join(", ") || "unknown", original.text);
    }
    if (mode === "forward" && original && prepared.replyTo?.quote_original !== false) {
      text += forwardOriginal(original);
    }
    let attachments: OriginalMail["attachments"] = [];
    if (mode === "forward" && original && prepared.replyTo?.include_attachments === true) {
      const forwarded = takeForwardAttachments(original.attachments);
      attachments = forwarded.attachments;
      warnings.push(...forwarded.warnings);
    }
    const inReplyTo = mode === "reply" && original?.messageId ? normalizeMessageId(original.messageId) : null;
    const references =
      original && (mode === "reply" || mode === "forward") ? capReferences(original.references, original.messageId) : [];
    const recipientCount = recipients.to.length + recipients.cc.length + recipients.bcc.length;
    const built = await buildRawMessage({
      accountEmail: account.email,
      ...(prepared.fromName ? { fromName: prepared.fromName } : {}),
      to: recipients.to,
      cc: recipients.cc,
      bcc: recipients.bcc,
      subject,
      text,
      ...(inReplyTo ? { inReplyTo } : {}),
      ...(references.length > 0 ? { references } : {}),
      ...(attachments.length > 0 ? { attachments } : {}),
    });
    await deps.smtp.send(account, {
      raw: built.raw,
      envelope: { from: account.email, to: [...recipients.to, ...recipients.cc, ...recipients.bcc] },
    });
    deps.sends.finish(reserved.id, "sent", built.messageId, null, recipientCount);
    const copy = await saveSentCopy(deps, account, built.raw, warnings);
    const data: SendData = {
      sent: true,
      message_id: built.messageId,
      account: account.id,
      from: account.email,
      to: recipients.to,
      cc: recipients.cc,
      bcc: recipients.bcc,
      subject,
      in_reply_to: inReplyTo,
      body_chars: prepared.body.length,
      sent_copy: copy,
      warnings,
    };
    return ok(data, { warnings });
  } catch (err) {
    const mail = asSendError(err, account);
    deps.sends.finish(reserved.id, "failed", null, mail.code);
    return fail(mail.code, mail.message);
  }
}

function prepareText(input: SendInput, maxRecipients: number): PreparedText {
  if (!input.to || input.to.length < 1) {
    throw new MailError("invalid_argument", "Enter at least one recipient");
  }
  const supplied = [...input.to, ...(input.cc ?? []), ...(input.bcc ?? [])];
  if (supplied.length > maxRecipients) {
    throw new MailError("invalid_argument", `A message can have at most ${maxRecipients} recipients`);
  }
  const to = input.to.map(parseOneAddress);
  const cc = input.cc?.map(parseOneAddress);
  const bcc = input.bcc?.map(parseOneAddress);
  if (typeof input.body !== "string" || input.body.length === 0 || input.body.length > BODY_MAX) {
    throw new MailError("invalid_argument", `Body must be 1 to ${BODY_MAX} characters`);
  }
  let fromName: string | undefined;
  if (input.from_name !== undefined && input.from_name.trim() !== "") {
    const name = input.from_name.trim();
    if (name.length > FROM_NAME_MAX) throw new MailError("invalid_argument", `From name must be at most ${FROM_NAME_MAX} characters`);
    assertHeaderText(name, "From name");
    fromName = name;
  }
  let subject: string | undefined;
  if (input.subject !== undefined && input.subject.trim() !== "") {
    const value = input.subject.trim();
    if (value.length > SUBJECT_MAX) throw new MailError("invalid_argument", `Subject must be at most ${SUBJECT_MAX} characters`);
    assertHeaderText(value, "Subject");
    subject = value;
  }
  if (!input.reply_to && !subject) throw new MailError("invalid_argument", "Subject is required");
  return {
    accountId: input.account,
    to,
    ...(cc ? { cc } : {}),
    ...(bcc ? { bcc } : {}),
    ...(subject ? { subject } : {}),
    body: input.body,
    ...(fromName ? { fromName } : {}),
    ...(input.reply_to ? { replyTo: input.reply_to } : {}),
  };
}

async function loadOriginal(deps: SendDeps, account: AccountCredentials, reply: ReplyTarget): Promise<OriginalMail> {
  const message = await deps.imap.withMailbox(account, reply.folder, (session) => session.fetchOne(reply.uid, ORIGINAL_FETCH));
  if (!message?.source) throw new MailError("not_found", "Message was not found");
  return originalFromSource(message.source);
}

function chooseSubject(
  given: string | undefined,
  mode: "new" | "reply" | "forward",
  original: OriginalMail | undefined,
): string {
  if (given) return given;
  const base = stripControls(original?.subject ?? "");
  const derived = mode === "forward" ? forwardSubject(base) : mode === "reply" ? replySubject(base) : "";
  if (!derived) throw new MailError("invalid_argument", "Subject is required");
  return derived.length > SUBJECT_MAX ? derived.slice(0, SUBJECT_MAX) : derived;
}

async function saveSentCopy(
  deps: SendDeps,
  account: AccountCredentials,
  raw: Buffer,
  warnings: string[],
): Promise<{ saved: boolean; folder: string | null }> {
  if (account.autoSavesSent) {
    warnings.push("This mailbox keeps its own Sent copy.");
    return { saved: false, folder: null };
  }
  try {
    const folders = await deps.imap.withClient(account, (session) => session.list());
    const sent = findSentFolder(folders);
    if (!sent) {
      warnings.push("The message was sent, but a copy was not saved because no Sent folder was found.");
      return { saved: false, folder: null };
    }
    await deps.imap.appendMessage(account, sent.path, raw, ["\\Seen"]);
    return { saved: true, folder: sent.path };
  } catch {
    warnings.push("The message was sent, but a copy was not saved to Sent.");
    return { saved: false, folder: null };
  }
}

export function findSentFolder(folders: readonly ListedMailbox[]): ListedMailbox | null {
  const special = folders.find((folder) => isSentSpecial(folder));
  if (special) return special;
  for (const name of SENT_NAMES) {
    const found = folders.find((folder) => folder.path.toLowerCase() === name || folder.name.toLowerCase() === name);
    if (found) return found;
  }
  return null;
}

function isSentSpecial(folder: ListedMailbox): boolean {
  if (folder.specialUse?.toLowerCase() === "\\sent") return true;
  return folder.flags.some((flag) => flag.toLowerCase() === "\\sent");
}

function asSendError(err: unknown, account: AccountCredentials): MailError {
  const secrets = [account.password, account.smtpAuth.pass];
  const mail = err instanceof MailError ? err : toSmtpError(toMailError(err, account.password), secrets);
  let message = mail.message;
  for (const secret of secrets) message = scrubSecret(message, secret);
  return message === mail.message ? mail : new MailError(mail.code, message);
}

function suppliedCount(prepared: PreparedText): number {
  return prepared.to.length + (prepared.cc?.length ?? 0) + (prepared.bcc?.length ?? 0);
}

function dashboardUrl(publicUrl: string | undefined): string {
  const base = publicUrl?.trim().replace(/\/+$/, "");
  return base ? `${base}/dashboard` : "/dashboard";
}

function clipLabel(value: string): string {
  const clean = value.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  return clean.slice(0, 200) || "unknown";
}
