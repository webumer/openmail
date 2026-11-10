import {
  ImapFlow,
  type FetchMessageObject,
  type FetchQueryObject,
  type ImapFlowOptions,
  type ListResponse,
  type MailboxLockObject,
  type MessageStructureObject,
  type SearchObject,
  type StatusObject,
} from "imapflow";
import { imapTimeoutFromEnv } from "../config/runtime.js";
import { MESSAGE_SOURCE_CAP_BYTES } from "./constants.js";
import { createDeadline, type Deadline } from "./deadline.js";
import type { AccountCredentials } from "../store/types.js";
import { MailError, toMailError } from "../errors.js";
import { buildImapConnectOptions } from "./tls.js";
import { defaultResolver, resolveConnectTarget, type Resolver } from "./address-guard.js";
import { parseThreadResponse, threadContaining } from "./thread.js";
import type { BodyNode } from "./structure.js";
import type {
  FetchedMessage,
  ImapSession,
  ListedMailbox,
  MailboxStatus,
  MessageFetchQuery,
} from "./session.js";

/**
 * Receive limits for one connection, enforced by imapflow's parser while the
 * response is read: a literal or response over the limit fails the connection
 * before its bytes are buffered, and the call rejects with `too_large`.
 */
export interface ImapReceiveLimits {
  /** Largest single literal (for example one body part) the server may send. */
  maxLiteralBytes: number;
}

/**
 * Default receive limits. The largest legitimate literal elsewhere is a
 * read_message source, which is requested as BODY.PEEK[]<0.10 MB>; a server
 * that ignores the range cannot make the connection buffer more than this.
 */
export const DEFAULT_MAX_LITERAL_BYTES = MESSAGE_SOURCE_CAP_BYTES + 1024 * 1024;
/** Room for the rest of one response (framing, other fetch items, long SEARCH lines). */
const RESPONSE_HEADROOM_BYTES = 16 * 1024 * 1024;
const LIMIT_ERROR_CODES = new Set(["LiteralTooLarge", "ResponseTooLarge", "LineTooLarge", "TooManyTokens"]);

export interface ImapGateway {
  withClient<T>(account: AccountCredentials, fn: (session: ImapSession) => Promise<T>): Promise<T>;
  /** Opens the mailbox with EXAMINE (`readOnly: true`) and releases the lock afterwards. */
  withMailbox<T>(account: AccountCredentials, folder: string, fn: (session: ImapSession) => Promise<T>, limits?: ImapReceiveLimits): Promise<T>;
  /**
   * APPEND one message. Does not SELECT or EXAMINE any mailbox, so it cannot
   * change flags on mail that is already there. This is the only IMAP write.
   */
  appendMessage(account: AccountCredentials, folder: string, raw: Buffer, flags: string[]): Promise<void>;
}

interface ExecResult {
  next?: () => void;
}

interface ImapClient {
  connect(): Promise<void>;
  logout(): Promise<void>;
  close(): void;
  /** imapflow emits terminal parser errors (such as LiteralTooLarge) here. */
  on?(event: "error", listener: (err: unknown) => void): unknown;
  capabilities: Map<string, boolean | number>;
  list(options?: { statusQuery?: { messages?: boolean; unseen?: boolean } }): Promise<ListResponse[]>;
  status(path: string, query: { messages?: boolean; unseen?: boolean }): Promise<StatusObject | false>;
  getMailboxLock(path: string, options?: { readOnly?: boolean }): Promise<MailboxLockObject>;
  search(query: SearchObject, options?: { uid?: boolean }): Promise<number[] | false | undefined>;
  fetchOne(seq: number, query: FetchQueryObject, options?: { uid?: boolean }): Promise<FetchMessageObject | false | undefined>;
  fetchAll(range: number[], query: FetchQueryObject, options?: { uid?: boolean }): Promise<FetchMessageObject[]>;
  exec?(
    command: string,
    attributes: readonly unknown[],
    options?: {
      untagged?: Record<string, (response: { attributes?: unknown }) => void>;
    },
  ): Promise<ExecResult>;
  /** APPEND does not select the mailbox and does not change flags on other messages. */
  append?(path: string, content: Buffer | string, flags?: string[]): Promise<unknown>;
}

export interface ImapGatewayOptions {
  /** DNS lookup used to pin each connection to a checked public address. Tests inject one. */
  resolve?: Resolver;
  /** Small injected values are allowed for deterministic tests. */
  timeoutMs?: number;
  graceMs?: number;
}

export function createImapGateway(
  factory: (options: ImapFlowOptions) => ImapClient = defaultClient,
  gatewayOptions: ImapGatewayOptions = {},
): ImapGateway {
  const resolve = gatewayOptions.resolve ?? defaultResolver;
  const timeoutMs = gatewayOptions.timeoutMs ?? imapTimeoutFromEnv();
  const graceMs = gatewayOptions.graceMs ?? 5_000;
  return {
    withClient(account, fn) {
      return run(factory, resolve, timeoutMs, graceMs, account, async (session) => fn(session));
    },
    withMailbox(account, folder, fn, limits) {
      return run(factory, resolve, timeoutMs, graceMs, account, async (session, client) => {
        const lock = await client.getMailboxLock(folder, { readOnly: true });
        try {
          return await fn(session);
        } finally {
          lock.release();
        }
      }, limits);
    },
    appendMessage(account, folder, raw, flags) {
      return run(factory, resolve, timeoutMs, graceMs, account, async (_session, client) => {
        if (!client.append) throw new Error("APPEND is not available");
        await client.append(folder, raw, flags);
      });
    },
  };
}

function defaultClient(options: ImapFlowOptions): ImapClient {
  const client = new ImapFlow(options);
  client.on("error", () => { /* The operation promise reports a sanitized error. */ });
  return client as unknown as ImapClient;
}

async function run<T>(
  factory: (options: ImapFlowOptions) => ImapClient,
  resolve: Resolver,
  timeoutMs: number,
  graceMs: number,
  account: AccountCredentials,
  fn: (session: ImapSession, client: ImapClient) => Promise<T>,
  limits: ImapReceiveLimits = { maxLiteralBytes: DEFAULT_MAX_LITERAL_BYTES },
): Promise<T> {
  const deadline = createDeadline({ timeoutMs });
  let client: ImapClient | undefined;
  let closed = false;
  const close = () => {
    if (client && !closed) {
      closed = true;
      safeClose(client);
    }
  };
  let timedOut = false;
  let overLimit = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = () => new MailError("timeout", "The mail server took too long. Try a narrower search or try again later.", "timeout");
  const work = async (): Promise<T> => {
    try {
      const options = buildImapConnectOptions(account);
      const target = await resolveConnectTarget(account, resolve);
      if (timedOut) throw timeout();
      options.host = target.host;
      if (target.servername) options.servername = target.servername;
      options.maxLiteralSize = limits.maxLiteralBytes;
      options.maxResponseSize = limits.maxLiteralBytes + RESPONSE_HEADROOM_BYTES;
      client = factory(options);
      client.on?.("error", (err) => {
        if (isLimitError(err)) overLimit = true;
      });
      await client.connect();
      if (timedOut) throw timeout();
      return await fn(createSession(client, deadline), client);
    } catch (err) {
      close();
      if (overLimit || isLimitError(err)) {
        throw new MailError("too_large", "The mail server sent more data than the size limit allows, so the download was stopped.");
      }
      throw toMailError(err, account.password);
    } finally {
      if (client && !closed) {
        if (timedOut) close();
        else {
          try {
            await client.logout();
          } catch {
            close();
          }
        }
      }
    }
  };
  const working = work();
  // The socket may reject pending work after the hard timeout has already returned.
  void working.catch(() => {});
  try {
    return await Promise.race([
      working,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          timedOut = true;
          // Reject first, so any synchronous close-induced error cannot replace timeout.
          reject(timeout());
          close();
        }, timeoutMs + graceMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function isLimitError(err: unknown): boolean {
  const code = err && typeof err === "object" ? (err as { code?: unknown }).code : undefined;
  return typeof code === "string" && LIMIT_ERROR_CODES.has(code);
}

function safeClose(client: ImapClient): void {
  try {
    client.close();
  } catch {
    // The socket is already unusable.
  }
}

function createSession(client: ImapClient, deadline: Deadline): ImapSession {
  const capabilities = new Set<string>();
  for (const key of client.capabilities.keys()) {
    capabilities.add(key);
    capabilities.add(key.toUpperCase());
  }
  const session: ImapSession = {
    capabilities,
    deadline,
    async list() {
      const entries = await client.list({ statusQuery: { messages: true, unseen: true } });
      return entries.map(mapListed);
    },
    async status(path) {
      const status = await client.status(path, { messages: true, unseen: true });
      if (!status) return null;
      return {
        messages: typeof status.messages === "number" ? status.messages : null,
        unseen: typeof status.unseen === "number" ? status.unseen : null,
      };
    },
    async search(query) {
      const result = await client.search(query, { uid: true });
      return Array.isArray(result) ? result : [];
    },
    async fetchOne(uid, query) {
      const message = await client.fetchOne(uid, toFetchQuery(query), { uid: true });
      if (!message) return null;
      return mapFetched(message);
    },
    async fetchAll(uids, query) {
      if (uids.length === 0) return [];
      const messages = await client.fetchAll(uids, toFetchQuery(query), { uid: true });
      return messages.map(mapFetched);
    },
    async fetchPart(uid, section, maxBytes) {
      // bodyParts are fetched as BODY.PEEK[section]<0.n> (imapflow uses BINARY only when asked), so \\Seen is never set.
      const message = await client.fetchOne(uid, { uid: true, bodyParts: [{ key: section, start: 0, maxLength: maxBytes }] }, { uid: true });
      if (!message) return null;
      return message.bodyParts?.get(section.toLowerCase()) ?? message.bodyParts?.get(section) ?? null;
    },
    thread: (algorithm, seedUid) => runThread(client, algorithm, seedUid),
  };
  return session;
}

/**
 * imapflow 2 has no THREAD wrapper. The command goes through its internal
 * `exec` and falls back to header search when the server refuses it.
 * Body fetches elsewhere always use BODY.PEEK (imapflow `source` / `headers`).
 */
async function runThread(client: ImapClient, algorithm: "REFS" | "REFERENCES", seedUid: number): Promise<number[] | null> {
  const exec = client.exec;
  if (!exec) return null;
  const threads: number[][] = [];
  let result: ExecResult | undefined;
  try {
    result = await exec(
      "UID THREAD",
      [
        { type: "ATOM", value: algorithm },
        { type: "ATOM", value: "UTF-8" },
        { type: "ATOM", value: "ALL" },
      ],
      {
        untagged: {
          THREAD: (response) => {
            for (const thread of parseThreadResponse(response.attributes)) threads.push(thread);
          },
        },
      },
    );
    return threadContaining(threads, seedUid);
  } catch {
    return null;
  } finally {
    try {
      result?.next?.();
    } catch {
      // The reader park is released on a best-effort basis.
    }
  }
}

function toFetchQuery(query: MessageFetchQuery): FetchQueryObject {
  const fetchQuery: FetchQueryObject = { uid: true };
  if (query.flags) fetchQuery.flags = true;
  if (query.envelope) fetchQuery.envelope = true;
  if (query.bodyStructure) fetchQuery.bodyStructure = true;
  if (query.internalDate) fetchQuery.internalDate = true;
  if (query.size) fetchQuery.size = true;
  if (query.source) {
    // Partial fetches still use BODY.PEEK[]<0.n>, so \\Seen is never set.
    fetchQuery.source = query.source === true ? true : { start: 0, maxLength: query.source.maxLength };
  }
  if (query.headers) fetchQuery.headers = [...query.headers];
  return fetchQuery;
}

function mapListed(entry: ListResponse): ListedMailbox {
  return {
    path: entry.path,
    name: entry.name,
    delimiter: entry.delimiter,
    specialUse: entry.specialUse ?? null,
    flags: [...entry.flags],
    messages: typeof entry.status?.messages === "number" ? entry.status.messages : null,
    unseen: typeof entry.status?.unseen === "number" ? entry.status.unseen : null,
  };
}

function mapFetched(message: FetchMessageObject): FetchedMessage {
  const envelope = message.envelope;
  return {
    uid: message.uid,
    flags: [...(message.flags ?? [])],
    envelope: envelope
      ? {
          ...(asDate(envelope.date) ? { date: asDate(envelope.date) } : {}),
          ...(envelope.subject !== undefined ? { subject: envelope.subject } : {}),
          ...(envelope.messageId !== undefined ? { messageId: envelope.messageId } : {}),
          ...(envelope.inReplyTo !== undefined ? { inReplyTo: envelope.inReplyTo } : {}),
          ...(envelope.from ? { from: envelope.from } : {}),
          ...(envelope.to ? { to: envelope.to } : {}),
          ...(envelope.cc ? { cc: envelope.cc } : {}),
          ...(envelope.replyTo ? { replyTo: envelope.replyTo } : {}),
        }
      : null,
    bodyStructure: mapStructure(message.bodyStructure),
    internalDate: asDate(message.internalDate),
    size: typeof message.size === "number" ? message.size : null,
    source: message.source ?? null,
    headers: message.headers ?? null,
  };
}

function mapStructure(node: MessageStructureObject | undefined): BodyNode | null {
  if (!node) return null;
  const children = node.childNodes?.map((child) => mapStructure(child)).filter((child): child is BodyNode => child !== null);
  return {
    type: node.type,
    part: node.part ?? null,
    disposition: node.disposition ?? null,
    parameters: node.parameters ?? null,
    dispositionParameters: node.dispositionParameters ?? null,
    id: node.id ?? null,
    encoding: node.encoding ? node.encoding.toLowerCase() : null,
    size: typeof node.size === "number" ? node.size : null,
    childNodes: children && children.length > 0 ? children : null,
  };
}

function asDate(value: Date | string | undefined): Date | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === "string" && value.trim()) {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  return null;
}
