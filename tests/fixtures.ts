import type { SearchObject } from "imapflow";
import type { AccountCredentials } from "../src/store/types.js";
import type { FetchedMessage, ListedMailbox, MessageFetchQuery } from "../src/mail/session.js";

export const SECRET = "test-secret-value";

export const account: AccountCredentials = {
  id: "work",
  label: "Work",
  email: "you@example.com",
  preset: "migadu",
  username: "you@example.com",
  password: SECRET,
  imap: { host: "imap.migadu.com", port: 993, secure: true },
  smtp: { host: "smtp.migadu.com", port: 465, secure: true, starttls: false },
  allowInsecureLocalhost: false,
  sendEnabled: false,
  smtpAuth: { user: "you@example.com", pass: SECRET },
  autoSavesSent: false,
};

export function textMail(headers: Record<string, string>, body: string): Buffer {
  const lines = Object.entries(headers).map(([name, value]) => `${name}: ${value}`);
  return Buffer.from(`${lines.join("\r\n")}\r\n\r\n${body}`);
}

export function fetched(overrides: Partial<FetchedMessage> & Pick<FetchedMessage, "uid">): FetchedMessage {
  return {
    flags: [],
    envelope: null,
    bodyStructure: { type: "text/plain" },
    internalDate: null,
    size: 100,
    source: null,
    headers: null,
    ...overrides,
  };
}

export function mailbox(overrides: Partial<ListedMailbox> & Pick<ListedMailbox, "path">): ListedMailbox {
  return {
    name: overrides.path,
    delimiter: "/",
    specialUse: null,
    flags: [],
    messages: null,
    unseen: null,
    ...overrides,
  };
}

export class RecordingSession {
  readonly capabilities = new Set<string>();
  readonly searches: SearchObject[] = [];
  readonly fetches: MessageFetchQuery[] = [];
  readonly statusCalls: string[] = [];
  mailboxes: ListedMailbox[] = [];
  messages = new Map<number, FetchedMessage>();
  searchUids: number[] | null = null;
  threadResult: number[] | null = null;
  threadCalls = 0;
  statusError = false;

  async list(): Promise<ListedMailbox[]> {
    return this.mailboxes;
  }

  async status(path: string): Promise<{ messages: number | null; unseen: number | null } | null> {
    this.statusCalls.push(path);
    if (this.statusError) throw new Error("status failed");
    return { messages: 4, unseen: 2 };
  }

  async search(query: SearchObject): Promise<number[]> {
    this.searches.push(query);
    if (this.searchUids) return this.searchUids;
    return [...this.messages.keys()];
  }

  async fetchOne(uid: number, query: MessageFetchQuery): Promise<FetchedMessage | null> {
    this.fetches.push(query);
    return this.messages.get(uid) ?? null;
  }

  async fetchAll(uids: number[], query: MessageFetchQuery): Promise<FetchedMessage[]> {
    this.fetches.push(query);
    const found: FetchedMessage[] = [];
    for (const uid of uids) {
      const message = this.messages.get(uid);
      if (message) found.push(message);
    }
    return found;
  }

  async thread(): Promise<number[] | null> {
    this.threadCalls += 1;
    return this.threadResult;
  }
}
