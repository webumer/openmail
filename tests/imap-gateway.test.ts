import { ImapFlow, type FetchQueryObject, type ImapFlowOptions } from "imapflow";
import { describe, expect, it } from "vitest";
import { createImapGateway } from "../src/mail/imap-gateway.js";
import { listFolders, readMessage, readThread } from "../src/mail/operations.js";
import type { CredentialStore } from "../src/store/types.js";
import { SECRET, account } from "./fixtures.js";

describe("imap gateway", () => {
  it("opens read-only and fetches with BODY.PEEK-style source", async () => {
    const client = fakeClient();
    const gateway = createImapGateway(() => client);
    const result = await readMessage(deps(gateway), "user-1", "work", "INBOX", 9);
    expect(result.ok).toBe(true);
    const lock = client.calls.find((call) => call.method === "getMailboxLock");
    expect(lock?.args).toEqual(["INBOX", { readOnly: true }]);
    const fetch = client.calls.find((call) => call.method === "fetchOne");
    const query = fetch?.args[1] as FetchQueryObject;
    const options = fetch?.args[2];
    expect(query).toMatchObject({ uid: true, source: true, envelope: true, flags: true, bodyStructure: true });
    expect(options).toEqual({ uid: true });
    expect(client.calls.map((call) => call.method)).toEqual(["connect", "getMailboxLock", "fetchOne", "logout"]);
    expect(client.lockReleased).toBe(true);
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });

  it("releases the mailbox lock and logs out when fetch fails", async () => {
    const client = fakeClient();
    client.fetchError = new Error(`fetch failed ${SECRET}`);
    const gateway = createImapGateway(() => client);
    const result = await readMessage(deps(gateway), "user-1", "work", "INBOX", 9);
    expect(result).toMatchObject({ ok: false, error: { code: "imap_error" } });
    if (result.ok) return;
    expect(result.error.message).not.toContain(SECRET);
    expect(result.error.message).toContain("[redacted]");
    expect(client.lockReleased).toBe(true);
    expect(client.loggedOut).toBe(true);
  });

  it("runs UID THREAD when the capability is present and still opens read-only", async () => {
    const client = fakeClient();
    client.capabilities.set("THREAD=REFS", true);
    const gateway = createImapGateway(() => client);
    const result = await readThread(deps(gateway), "user-1", "work", "INBOX", 7);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.messages.map((message) => message.uid)).toEqual([7, 8]);
    const thread = client.calls.find((call) => call.method === "exec");
    expect(thread?.args[0]).toBe("UID THREAD");
    expect(thread?.args[1]).toEqual([
      { type: "ATOM", value: "REFS" },
      { type: "ATOM", value: "UTF-8" },
      { type: "ATOM", value: "ALL" },
    ]);
    expect(client.nextCalled).toBe(true);
    expect(client.calls.some((call) => call.method === "search")).toBe(false);
    expect(client.calls.find((call) => call.method === "getMailboxLock")?.args[1]).toEqual({ readOnly: true });
  });

  it("refuses cleartext to a remote host before creating a client", async () => {
    let created = false;
    const gateway = createImapGateway(() => {
      created = true;
      throw new Error("should not connect");
    });
    const result = await listFolders(deps(gateway, {
      ...account,
      imap: { host: "imap.example.com", port: 143, secure: false },
    }), "user-1", "work");
    expect(created).toBe(false);
    expect(result).toMatchObject({ ok: false, error: { code: "insecure_transport" } });
  });

  it("passes loopback cleartext options through with verification still on", async () => {
    let options: ImapFlowOptions | undefined;
    const gateway = createImapGateway((received) => {
      options = received;
      return fakeClient();
    });
    await listFolders(deps(gateway, {
      ...account,
      allowInsecureLocalhost: true,
      imap: { host: "127.0.0.1", port: 3143, secure: false },
    }), "user-1", "work");
    expect(options?.secure).toBe(false);
    expect(options?.doSTARTTLS).toBe(false);
    expect(options?.tls?.rejectUnauthorized).toBe(true);
    expect(options?.logger).toBe(false);
  });

  it("exposes imapflow's command runner used for THREAD", () => {
    const client = new ImapFlow({
      host: "127.0.0.1",
      port: 1993,
      secure: false,
      logger: false,
      doSTARTTLS: false,
    });
    expect(typeof (client as unknown as { exec?: unknown }).exec).toBe("function");
    client.close();
  });
});

function deps(imap: ReturnType<typeof createImapGateway>, credentials = account) {
  const store: CredentialStore = {
    async listAccounts() {
      return [{
        id: credentials.id,
        label: credentials.label,
        email: credentials.email,
        preset: credentials.preset,
        imapHost: credentials.imap.host,
      }];
    },
    async getAccount() {
      return credentials;
    },
  };
  return { store, imap };
}

function fakeClient() {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const client = {
    calls,
    fetchError: null as Error | null,
    lockReleased: false,
    loggedOut: false,
    nextCalled: false,
    capabilities: new Map<string, boolean | number>(),
    async connect() {
      calls.push({ method: "connect", args: [] });
    },
    async logout() {
      client.loggedOut = true;
      calls.push({ method: "logout", args: [] });
    },
    close() {
      calls.push({ method: "close", args: [] });
    },
    async list() {
      calls.push({ method: "list", args: [] });
      return [];
    },
    async status() {
      return false as const;
    },
    async getMailboxLock(path: string, options?: { readOnly?: boolean }) {
      calls.push({ method: "getMailboxLock", args: [path, options] });
      return {
        path,
        release() {
          client.lockReleased = true;
        },
      };
    },
    async search() {
      calls.push({ method: "search", args: [] });
      return [];
    },
    async fetchOne(uid: number, query: FetchQueryObject, options?: { uid?: boolean }) {
      calls.push({ method: "fetchOne", args: [uid, query, options] });
      if (client.fetchError) throw client.fetchError;
      return {
        seq: 1,
        uid,
        source: mime("<m@example.com>", "Wed, 21 Oct 2026 18:19:00 +0000", "hello"),
        flags: new Set(["\\Flagged"]),
        envelope: { subject: "Hi", messageId: "<m@example.com>" },
        size: 20,
      };
    },
    async fetchAll(uids: number[], query: FetchQueryObject, options?: { uid?: boolean }) {
      calls.push({ method: "fetchAll", args: [uids, query, options] });
      return uids.map((uid) => ({
        seq: uid,
        uid,
        source: mime(
          `<${uid}@example.com>`,
          uid === 7 ? "Wed, 21 Oct 2026 10:00:00 +0000" : "Wed, 21 Oct 2026 12:00:00 +0000",
          `body-${uid}`,
        ),
        flags: new Set<string>(),
        envelope: { subject: `s${uid}`, messageId: `<${uid}@example.com>` },
        size: 20,
      }));
    },
    async exec(
      command: string,
      attributes: readonly unknown[],
      options?: { untagged?: { THREAD?: (response: { attributes?: unknown }) => void } },
    ) {
      calls.push({ method: "exec", args: [command, attributes] });
      options?.untagged?.THREAD?.({
        attributes: [[{ type: "ATOM", value: "7" }, { type: "ATOM", value: "8" }]],
      });
      return {
        next() {
          client.nextCalled = true;
        },
      };
    },
  };
  return client;
}

function mime(id: string, date: string, body: string): Buffer {
  return Buffer.from([
    "From: Ada <ada@example.com>",
    "To: Bo <bo@example.com>",
    `Subject: ${id}`,
    `Date: ${date}`,
    `Message-ID: ${id}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "",
    body,
  ].join("\r\n"));
}
