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
import type { AccountCredentials } from "../store/types.js";
import { toMailError } from "../errors.js";
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

export interface ImapGateway {
  withClient<T>(account: AccountCredentials, fn: (session: ImapSession) => Promise<T>): Promise<T>;
  /** Opens the mailbox with EXAMINE (`readOnly: true`) and releases the lock afterwards. */
  withMailbox<T>(account: AccountCredentials, folder: string, fn: (session: ImapSession) => Promise<T>): Promise<T>;
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
}

export function createImapGateway(
  factory: (options: ImapFlowOptions) => ImapClient = defaultClient,
  gatewayOptions: ImapGatewayOptions = {},
): ImapGateway {
  const resolve = gatewayOptions.resolve ?? defaultResolver;
  return {
    withClient(account, fn) {
      return run(factory, resolve, account, async (session) => fn(session));
    },
    withMailbox(account, folder, fn) {
      return run(factory, resolve, account, async (session, client) => {
        const lock = await client.getMailboxLock(folder, { readOnly: true });
        try {
          return await fn(session);
        } finally {
          lock.release();
        }
      });
    },
    appendMessage(account, folder, raw, flags) {
      return run(factory, resolve, account, async (_session, client) => {
        if (!client.append) throw new Error("APPEND is not available");
        await client.append(folder, raw, flags);
      });
    },
  };
}

function defaultClient(options: ImapFlowOptions): ImapClient {
  return new ImapFlow(options) as unknown as ImapClient;
}

async function run<T>(
  factory: (options: ImapFlowOptions) => ImapClient,
  resolve: Resolver,
  account: AccountCredentials,
  fn: (session: ImapSession, client: ImapClient) => Promise<T>,
): Promise<T> {
  // Transport rules first (no DNS for a refused cleartext host), then pin the
  // socket to an address checked just now, so DNS cannot move it to a private one.
  const options = buildImapConnectOptions(account);
  const target = await resolveConnectTarget(account, resolve);
  options.host = target.host;
  if (target.servername) options.servername = target.servername;
  const client = factory(options);
  try {
    await client.connect();
  } catch (err) {
    safeClose(client);
    throw toMailError(err, account.password);
  }
  try {
    return await fn(createSession(client), client);
  } catch (err) {
    throw toMailError(err, account.password);
  } finally {
    try {
      await client.logout();
    } catch {
      safeClose(client);
    }
  }
}

function safeClose(client: ImapClient): void {
  try {
    client.close();
  } catch {
    // The socket is already unusable.
  }
}

function createSession(client: ImapClient): ImapSession {
  const capabilities = new Set<string>();
  for (const key of client.capabilities.keys()) {
    capabilities.add(key);
    capabilities.add(key.toUpperCase());
  }
  const session: ImapSession = {
    capabilities,
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
    disposition: node.disposition ?? null,
    parameters: node.parameters ?? null,
    dispositionParameters: node.dispositionParameters ?? null,
    id: node.id ?? null,
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
