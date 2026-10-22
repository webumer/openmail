import type { AccountCredentials, CredentialStore } from "../store/types.js";
import { MailError } from "../errors.js";
import { envelopeAddresses, type MailAddress } from "./addresses.js";
import {
  ATTACHMENT_SCAN_CAP,
  BODY_CHAR_CAP,
  MESSAGE_SOURCE_CAP_BYTES,
  THREAD_SOURCE_CAP_BYTES,
  SEARCH_DEFAULT_LIMIT,
  SEARCH_MAX_LIMIT,
  STATUS_FANOUT_LIMIT,
  THREAD_CHAR_CAP,
  THREAD_MESSAGE_CAP,
  UNTRUSTED_CONTENT_WARNING,
} from "./constants.js";
import { decodeCursor, encodeCursor, type CursorPayload } from "./cursor.js";
import { headerValue, normalizeDate, type NormalizedDate } from "./dates.js";
import type { ImapGateway } from "./imap-gateway.js";
import { parseMessage, type AttachmentInfo, type MessageHeaders } from "./parse-message.js";
import { fail, ok, type ToolResult } from "./result.js";
import { buildSearchQuery } from "./search-query.js";
import type { FetchedMessage, ImapSession, MessageFetchQuery } from "./session.js";
import { hasAttachments } from "./structure.js";
import { allocateText, capText } from "./text.js";
import { collectThreadIds, limitThreadUids, threadAlgorithm } from "./thread.js";

export interface MailDeps {
  store: CredentialStore;
  imap: ImapGateway;
}

const READ_FETCH: MessageFetchQuery = {
  source: { maxLength: MESSAGE_SOURCE_CAP_BYTES },
  envelope: true,
  flags: true,
  bodyStructure: true,
  internalDate: true,
  size: true,
  headers: ["date", "message-id", "in-reply-to", "references"],
};

const THREAD_FETCH: MessageFetchQuery = { ...READ_FETCH, source: { maxLength: THREAD_SOURCE_CAP_BYTES } };

function sourceTruncated(message: FetchedMessage, cap: number): boolean {
  return typeof message.size === "number" && message.size > cap;
}

function partialWarning(cap: number): string {
  return `Message is larger than ${Math.round(cap / (1024 * 1024))} MB; only the first part was read, so text and attachments may be incomplete.`;
}

const SEARCH_FETCH: MessageFetchQuery = {
  envelope: true,
  flags: true,
  bodyStructure: true,
  internalDate: true,
  size: true,
  headers: ["date"],
};

export interface AccountListItem {
  id: string;
  label: string;
  email: string;
  preset: string;
  imap_host: string;
  sending_enabled: boolean;
}

export interface FolderInfo {
  path: string;
  name: string;
  special_use: string | null;
  delimiter: string;
  messages: number | null;
  unseen: number | null;
}

export interface SearchParams {
  folder?: string;
  from?: string;
  to?: string;
  subject?: string;
  text?: string;
  since?: string;
  before?: string;
  unread?: boolean;
  has_attachment?: boolean;
  limit?: number;
  cursor?: string;
}

export interface SearchHit {
  uid: number;
  folder: string;
  message_id: string | null;
  subject: string | null;
  from: MailAddress[];
  to: MailAddress[];
  date: NormalizedDate | null;
  flags: string[];
  seen: boolean;
  has_attachments: boolean;
  size: number | null;
}

export interface SearchData {
  messages: SearchHit[];
  next_cursor: string | null;
}

export interface ReadMessage {
  uid: number;
  folder: string;
  headers: MessageHeaders;
  text: string;
  attachments: AttachmentInfo[];
  flags: string[];
  seen: boolean;
  size: number | null;
}

export interface ThreadMessage {
  uid: number;
  headers: MessageHeaders;
  text: string;
  attachments: AttachmentInfo[];
  flags: string[];
  seen: boolean;
}

export interface ThreadData {
  folder: string;
  seed_uid: number;
  messages: ThreadMessage[];
}

export async function listAccounts(
  store: CredentialStore,
  userId: string,
  options?: { canSend?: boolean },
): Promise<ToolResult<AccountListItem[]>> {
  return guard(async () => {
    requireUser(userId);
    const accounts = await store.listAccounts(userId);
    const canSend = options?.canSend ?? true;
    return ok(
      accounts.map((account) => ({
        id: account.id,
        label: account.label,
        email: account.email,
        preset: account.preset,
        imap_host: account.imapHost,
        sending_enabled: account.sendEnabled,
      })),
      canSend ? undefined : { warnings: ["This connection is read-only"] },
    );
  });
}

export async function listFolders(
  deps: MailDeps,
  userId: string,
  accountId: string,
): Promise<ToolResult<FolderInfo[]>> {
  return guard(async () => {
    const account = await requireAccount(deps.store, userId, accountId);
    return deps.imap.withClient(account, async (session) => {
      const listed = (await session.list()).map((folder) => ({ ...folder, flags: [...folder.flags] }));
      const warnings: string[] = [];
      const missing = listed.filter(
        (folder) => folder.messages === null && folder.unseen === null && !isNoselect(folder.flags),
      );
      if (missing.length > STATUS_FANOUT_LIMIT) {
        warnings.push("Folder counts omitted because STATUS for every folder would be expensive.");
      } else {
        for (const folder of missing) {
          try {
            const status = await session.status(folder.path);
            if (!status) continue;
            folder.messages = status.messages;
            folder.unseen = status.unseen;
          } catch {
            warnings.push(`Counts unavailable for ${folder.path}.`);
          }
        }
      }
      return ok(
        listed.map((folder) => ({
          path: folder.path,
          name: folder.name,
          special_use: folder.specialUse,
          delimiter: folder.delimiter,
          messages: folder.messages,
          unseen: folder.unseen,
        })),
        { warnings },
      );
    });
  });
}

export async function searchMessages(
  deps: MailDeps,
  userId: string,
  accountId: string,
  params: SearchParams = {},
): Promise<ToolResult<SearchData>> {
  return guard(async () => {
    const folder = params.folder === undefined ? "INBOX" : requireFolder(params.folder);
    const limit = normalizeLimit(params.limit);
    const cursor = params.cursor === undefined ? null : decodeCursor(params.cursor);
    const query = buildSearchQuery(params);
    const account = await requireAccount(deps.store, userId, accountId);
    return deps.imap.withMailbox(account, folder, async (session) => {
      const uids = uniquePositive(await session.search(query));
      const { page, hasMore, scanCapped } = await collectPage(session, uids, params.has_attachment, limit, cursor);
      const warnings = [UNTRUSTED_CONTENT_WARNING];
      if (scanCapped) {
        warnings.push(
          `Only ${ATTACHMENT_SCAN_CAP} messages were checked for attachments; narrow the search (for example with since/before) to see older ones.`,
        );
      }
      return ok(
        {
          messages: page.map((message) => toSearchHit(message, folder)),
          next_cursor: nextCursor(cursor, page, hasMore),
        },
        { warnings },
      );
    });
  });
}

export async function readMessage(
  deps: MailDeps,
  userId: string,
  accountId: string,
  folder: string,
  uid: number,
): Promise<ToolResult<ReadMessage>> {
  return guard(async () => {
    const path = requireFolder(folder);
    requireUid(uid);
    const account = await requireAccount(deps.store, userId, accountId);
    return deps.imap.withMailbox(account, path, async (session) => {
      const fetched = await session.fetchOne(uid, READ_FETCH);
      if (!fetched?.source) throw new MailError("not_found", `Message ${uid} was not found in ${path}`);
      const parsed = await parseSource(fetched.source);
      const capped = capText(parsed.text, BODY_CHAR_CAP);
      const warnings = [UNTRUSTED_CONTENT_WARNING];
      if (capped.truncated) warnings.push(`Body truncated to ${BODY_CHAR_CAP} characters.`);
      const partial = sourceTruncated(fetched, MESSAGE_SOURCE_CAP_BYTES);
      if (partial) warnings.push(partialWarning(MESSAGE_SOURCE_CAP_BYTES));
      return ok(
        {
          uid: fetched.uid,
          folder: path,
          headers: parsed.headers,
          text: capped.text,
          attachments: parsed.attachments,
          flags: [...fetched.flags].sort(),
          seen: isSeen(fetched.flags),
          size: fetched.size,
        },
        { truncated: capped.truncated || partial, warnings },
      );
    });
  });
}

export async function readThread(
  deps: MailDeps,
  userId: string,
  accountId: string,
  folder: string,
  uid: number,
): Promise<ToolResult<ThreadData>> {
  return guard(async () => {
    const path = requireFolder(folder);
    requireUid(uid);
    const account = await requireAccount(deps.store, userId, accountId);
    return deps.imap.withMailbox(account, path, async (session) => {
      const warnings = [UNTRUSTED_CONTENT_WARNING];
      const resolved = await resolveThreadUids(session, uid, path, warnings);
      const limited = limitThreadUids(resolved, uid, THREAD_MESSAGE_CAP);
      if (limited.truncated) warnings.push(`Thread truncated to ${THREAD_MESSAGE_CAP} messages.`);
      const fetched = await fetchInOrder(session, limited.uids, THREAD_FETCH);
      const partial = fetched.some((message) => sourceTruncated(message, THREAD_SOURCE_CAP_BYTES));
      if (partial) warnings.push(partialWarning(THREAD_SOURCE_CAP_BYTES));
      if (!fetched.some((message) => message.uid === uid && message.source)) {
        throw new MailError("not_found", `Message ${uid} was not found in ${path}`);
      }
      const parsed: ParsedThreadItem[] = [];
      for (const message of fetched) {
        if (!message.source) {
          warnings.push(`Message ${message.uid} had no source.`);
          continue;
        }
        const body = await parseSource(message.source);
        const when = body.headers.date ? Date.parse(body.headers.date.utc) : Number.NaN;
        parsed.push({ message, body, when: Number.isNaN(when) ? null : when });
      }
      parsed.sort(compareOldest);
      const budget = allocateText(
        parsed.map((item) => item.body.text),
        THREAD_CHAR_CAP,
      );
      if (budget.truncated) warnings.push(`Thread body truncated to ${THREAD_CHAR_CAP} characters.`);
      return ok(
        {
          folder: path,
          seed_uid: uid,
          messages: parsed.map((item, index) => ({
            uid: item.message.uid,
            headers: item.body.headers,
            text: budget.parts[index] ?? "",
            attachments: item.body.attachments,
            flags: [...item.message.flags].sort(),
            seen: isSeen(item.message.flags),
          })),
        },
        { truncated: limited.truncated || budget.truncated || partial, warnings },
      );
    });
  });
}

interface ParsedThreadItem {
  message: FetchedMessage;
  body: Awaited<ReturnType<typeof parseMessage>>;
  when: number | null;
}

async function resolveThreadUids(
  session: ImapSession,
  seedUid: number,
  folder: string,
  warnings: string[],
): Promise<number[]> {
  const algorithm = threadAlgorithm(session.capabilities);
  if (algorithm && session.thread) {
    const threaded = await session.thread(algorithm, seedUid);
    if (threaded && threaded.length > 0) return threaded;
    warnings.push("THREAD extension did not return a thread; used header search.");
  }
  const seed = await session.fetchOne(seedUid, {
    envelope: true,
    headers: ["message-id", "in-reply-to", "references"],
  });
  if (!seed) throw new MailError("not_found", `Message ${seedUid} was not found in ${folder}`);
  const allIds = collectThreadIds({
    messageId: seed.envelope?.messageId ?? headerFrom(seed, "message-id"),
    inReplyTo: seed.envelope?.inReplyTo ?? headerFrom(seed, "in-reply-to"),
    references: headerFrom(seed, "references"),
  });
  if (allIds.length === 0) {
    warnings.push("Message has no Message-ID; thread is only that message.");
    return [seedUid];
  }
  const ids = allIds.slice(0, 32);
  if (allIds.length > ids.length) warnings.push("Thread search used the first 32 message ids.");
  const found = new Set<number>([seedUid]);
  for (const id of ids) {
    const matches = await session.search({
      or: [
        { header: { "message-id": id } },
        { header: { "in-reply-to": id } },
        { header: { references: id } },
      ],
    });
    for (const match of matches) found.add(match);
  }
  return [...found];
}

async function collectPage(
  session: ImapSession,
  uids: number[],
  hasAttachment: boolean | undefined,
  limit: number,
  cursor: CursorPayload | null,
): Promise<{ page: FetchedMessage[]; hasMore: boolean; scanCapped: boolean }> {
  const ordered = applyCursor(sortNewest(uids), cursor);
  if (hasAttachment === undefined) {
    const window = ordered.slice(0, limit + 1);
    const page = await fetchInOrder(session, window.slice(0, limit), SEARCH_FETCH);
    return { page, hasMore: window.length > limit, scanCapped: false };
  }
  const page: FetchedMessage[] = [];
  const chunkSize = 50;
  const scan = ordered.slice(0, ATTACHMENT_SCAN_CAP);
  for (let index = 0; index < scan.length; index += chunkSize) {
    const chunk = scan.slice(index, index + chunkSize);
    const fetched = await fetchInOrder(session, chunk, SEARCH_FETCH);
    for (const message of fetched) {
      if (hasAttachments(message.bodyStructure) !== hasAttachment) continue;
      if (page.length < limit) page.push(message);
      else return { page, hasMore: true, scanCapped: false };
    }
  }
  return { page, hasMore: false, scanCapped: ordered.length > scan.length };
}

async function fetchInOrder(
  session: ImapSession,
  uids: number[],
  query: MessageFetchQuery,
): Promise<FetchedMessage[]> {
  if (uids.length === 0) return [];
  const fetched = await session.fetchAll(uids, query);
  const byUid = new Map(fetched.map((message) => [message.uid, message]));
  const ordered: FetchedMessage[] = [];
  for (const uid of uids) {
    const message = byUid.get(uid);
    if (message) ordered.push(message);
  }
  return ordered;
}

function applyCursor(newestFirst: readonly number[], cursor: CursorPayload | null): number[] {
  if (!cursor) return [...newestFirst];
  if (cursor.uid != null) return newestFirst.filter((uid) => uid < cursor.uid!);
  return newestFirst.slice(cursor.offset);
}

function nextCursor(
  previous: CursorPayload | null,
  page: readonly { uid: number }[],
  hasMore: boolean,
): string | null {
  if (!hasMore || page.length === 0) return null;
  const last = page[page.length - 1];
  if (!last) return null;
  const offsetBase = previous?.uid != null ? 0 : (previous?.offset ?? 0);
  return encodeCursor({ v: 1, offset: offsetBase + page.length, uid: last.uid });
}

function toSearchHit(message: FetchedMessage, folder: string): SearchHit {
  return {
    uid: message.uid,
    folder,
    message_id: message.envelope?.messageId ?? null,
    subject: message.envelope?.subject ?? null,
    from: envelopeAddresses(message.envelope?.from),
    to: envelopeAddresses(message.envelope?.to),
    date: dateFromFetched(message),
    flags: [...message.flags].sort(),
    seen: isSeen(message.flags),
    has_attachments: hasAttachments(message.bodyStructure),
    size: message.size,
  };
}

function dateFromFetched(message: FetchedMessage): NormalizedDate | null {
  const raw = message.headers ? headerValue(message.headers.toString("utf8"), "date") : null;
  if (raw) return normalizeDate(raw, raw);
  if (message.envelope?.date) return normalizeDate(message.envelope.date);
  if (message.internalDate) return normalizeDate(message.internalDate);
  return null;
}

function headerFrom(message: FetchedMessage, name: string): string | null {
  if (!message.headers) return null;
  return headerValue(message.headers.toString("utf8"), name);
}

async function parseSource(source: Buffer): Promise<Awaited<ReturnType<typeof parseMessage>>> {
  try {
    return await parseMessage(source);
  } catch {
    throw new MailError("parse_error", "Message could not be parsed");
  }
}

function compareOldest(a: ParsedThreadItem, b: ParsedThreadItem): number {
  if (a.when === null && b.when === null) return a.message.uid - b.message.uid;
  if (a.when === null) return 1;
  if (b.when === null) return -1;
  if (a.when !== b.when) return a.when - b.when;
  return a.message.uid - b.message.uid;
}

function sortNewest(uids: readonly number[]): number[] {
  return [...uids].sort((a, b) => b - a);
}

function uniquePositive(uids: readonly number[]): number[] {
  const seen = new Set<number>();
  const out: number[] = [];
  for (const uid of uids) {
    if (!Number.isSafeInteger(uid) || uid <= 0 || seen.has(uid)) continue;
    seen.add(uid);
    out.push(uid);
  }
  return out;
}

function normalizeLimit(limit: number | undefined): number {
  if (limit === undefined) return SEARCH_DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > SEARCH_MAX_LIMIT) {
    throw new MailError("invalid_argument", `limit must be an integer from 1 to ${SEARCH_MAX_LIMIT}`);
  }
  return limit;
}

function requireFolder(folder: string): string {
  if (typeof folder !== "string" || folder.trim() === "") {
    throw new MailError("invalid_argument", "folder is required");
  }
  return folder.trim();
}

function requireUid(uid: number): void {
  if (!Number.isSafeInteger(uid) || uid <= 0) {
    throw new MailError("invalid_argument", "uid must be a positive integer");
  }
}

function requireUser(userId: string): void {
  if (typeof userId !== "string" || userId.trim() === "") {
    throw new MailError("invalid_argument", "userId is required");
  }
}

async function requireAccount(store: CredentialStore, userId: string, accountId: string): Promise<AccountCredentials> {
  requireUser(userId);
  if (typeof accountId !== "string" || accountId.trim() === "") {
    throw new MailError("invalid_argument", "account is required");
  }
  const account = await store.getAccount(userId, accountId);
  if (!account) throw new MailError("not_found", `Account ${accountId} was not found`);
  return account;
}

function isSeen(flags: readonly string[]): boolean {
  return flags.some((flag) => flag.toLowerCase() === "\\seen");
}

function isNoselect(flags: readonly string[]): boolean {
  return flags.some((flag) => {
    const value = flag.toLowerCase();
    return value === "\\noselect" || value === "noselect";
  });
}

async function guard<T>(fn: () => Promise<ToolResult<T>>): Promise<ToolResult<T>> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof MailError) return fail(err.code, err.message);
    return fail("internal_error", "Unexpected error");
  }
}
