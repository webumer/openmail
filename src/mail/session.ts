import type { SearchObject } from "imapflow";
import type { MailAddress } from "./addresses.js";
import type { BodyNode } from "./structure.js";
import type { ThreadAlgorithm } from "./thread.js";

export interface FetchedMessage {
  uid: number;
  flags: string[];
  envelope: {
    date?: Date | null;
    subject?: string;
    messageId?: string;
    inReplyTo?: string;
    from?: { name?: string; address?: string }[];
    to?: { name?: string; address?: string }[];
    cc?: { name?: string; address?: string }[];
    replyTo?: { name?: string; address?: string }[];
  } | null;
  bodyStructure: BodyNode | null;
  internalDate: Date | null;
  size: number | null;
  source: Buffer | null;
  headers: Buffer | null;
}

export interface MessageFetchQuery {
  source?: boolean;
  envelope?: boolean;
  flags?: boolean;
  bodyStructure?: boolean;
  internalDate?: boolean;
  size?: boolean;
  headers?: string[];
}

export interface ListedMailbox {
  path: string;
  name: string;
  delimiter: string;
  specialUse: string | null;
  flags: string[];
  messages: number | null;
  unseen: number | null;
}

export interface MailboxStatus {
  messages: number | null;
  unseen: number | null;
}

/**
 * Narrow IMAP session. Mailbox selection is the gateway's job and is always
 * read-only for these calls. `thread` is set when the connection can run the
 * THREAD extension; otherwise read tools search by header.
 */
export interface ImapSession {
  readonly capabilities: ReadonlySet<string>;
  list(): Promise<ListedMailbox[]>;
  status(path: string): Promise<MailboxStatus | null>;
  search(query: SearchObject): Promise<number[]>;
  fetchOne(uid: number, query: MessageFetchQuery): Promise<FetchedMessage | null>;
  fetchAll(uids: number[], query: MessageFetchQuery): Promise<FetchedMessage[]>;
  thread?(algorithm: ThreadAlgorithm, seedUid: number): Promise<number[] | null>;
}

export type { MailAddress };
