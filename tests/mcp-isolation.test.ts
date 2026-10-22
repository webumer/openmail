import { once } from "node:events";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { generateTestMasterKey, loadMasterKey } from "../src/crypto/index.js";
import { migrate, openDatabase } from "../src/db/index.js";
import type { ImapGateway } from "../src/mail/imap-gateway.js";
import { createSmtpGateway } from "../src/mail/smtp-gateway.js";
import { createMemorySendRecorder } from "../src/services/send-log.js";
import { authenticateDatabaseKey, createOpenMailServer } from "../src/server/index.js";
import { apiKeys, mailAccounts, users } from "../src/services/index.js";
import { SqliteCredentialStore } from "../src/store/index.js";

const ADA_MAILBOX = "ada-mailbox-secret";
const BOB_MAILBOX = "bob-mailbox-secret";

describe("MCP account isolation", () => {
  let db: Database;
  let server: Server;
  let port = 0;
  let adaKey = "";
  let bobKey = "";
  let adaUserId = "";
  let bobAccountId = "";
  let adaAccountId = "";
  let imapCalls = 0;

  const imap: ImapGateway = {
    withClient() {
      imapCalls += 1;
      return Promise.reject(new Error("IMAP gateway must not run"));
    },
    withMailbox() {
      imapCalls += 1;
      return Promise.reject(new Error("IMAP gateway must not run"));
    },
    appendMessage() {
      imapCalls += 1;
      return Promise.reject(new Error("IMAP gateway must not run"));
    },
  };

  beforeAll(async () => {
    const master = loadMasterKey(generateTestMasterKey());
    db = openDatabase(":memory:");
    migrate(db);
    const ada = await users.create(db, master, { email: "ada@example.com", password: "ada-password-1" });
    const bob = await users.create(db, master, { email: "bob@example.com", password: "bob-password-1" });
    adaAccountId = mailAccounts.add(db, master, {
      userId: ada.id,
      name: "Ada",
      email: "ada@work.example",
      preset: "migadu",
      password: ADA_MAILBOX,
    }).id;
    bobAccountId = mailAccounts.add(db, master, {
      userId: bob.id,
      name: "Bob",
      email: "bob@work.example",
      preset: "fastmail",
      password: BOB_MAILBOX,
    }).id;
    const adaCreated = apiKeys.create(db, { userId: ada.id, name: "ada" });
    const bobCreated = apiKeys.create(db, { userId: bob.id, name: "bob" });
    adaKey = adaCreated.token;
    adaUserId = ada.id;
    bobKey = bobCreated.token;

    server = createOpenMailServer({
      store: new SqliteCredentialStore(db, master),
      imap,
      smtp: createSmtpGateway(),
      sends: createMemorySendRecorder(),
      authenticate: (header) => authenticateDatabaseKey(db, header),
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    if (server) {
      await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    }
    db?.close();
  });

  it("lets each key list only that user's accounts", async () => {
    const health = await fetch(`http://127.0.0.1:${port}/healthz`);
    expect(health.status).toBe(200);

    const adaText = await toolText(port, adaKey, "list_accounts", {});
    const adaParsed = JSON.parse(adaText) as { ok: boolean; data: { id: string; email: string }[] };
    expect(adaParsed.ok).toBe(true);
    expect(adaParsed.data.map((account) => account.id)).toEqual([adaAccountId]);
    expect(adaText).not.toContain("bob@work.example");
    expect(adaText).not.toContain(ADA_MAILBOX);
    expect(adaText).not.toContain(BOB_MAILBOX);
    expect(adaText).not.toContain(adaKey);

    const bobText = await toolText(port, bobKey, "list_accounts", {});
    const bobParsed = JSON.parse(bobText) as { ok: boolean; data: { id: string; email: string }[] };
    expect(bobParsed.data.map((account) => account.id)).toEqual([bobAccountId]);
    expect(bobText).not.toContain("ada@work.example");
    expect(bobText).not.toContain(BOB_MAILBOX);
  });

  it("returns not found when a key reads another user's account", async () => {
    imapCalls = 0;
    const text = await toolText(port, adaKey, "list_folders", { account: bobAccountId });
    const parsed = JSON.parse(text) as { ok: boolean; error?: { code: string; message: string } };
    expect(parsed.ok).toBe(false);
    expect(parsed.error?.code).toBe("not_found");
    expect(text).not.toContain(BOB_MAILBOX);
    expect(text).not.toContain(adaKey);
    expect(imapCalls).toBe(0);

    const reverse = await toolText(port, bobKey, "read_message", {
      account: adaAccountId,
      folder: "INBOX",
      uid: 1,
    });
    const reverseParsed = JSON.parse(reverse) as { ok: boolean; error?: { code: string } };
    expect(reverseParsed.ok).toBe(false);
    expect(reverseParsed.error?.code).toBe("not_found");
    expect(reverse).not.toContain(ADA_MAILBOX);
    expect(imapCalls).toBe(0);
  });

  it("rejects a revoked key with 401 and still accepts the other user's key", async () => {
    const disposable = apiKeys.create(db, { userId: adaUserId, name: "revoke-me" });
    expect(apiKeys.resolve(db, disposable.token)?.userId).toBe(adaUserId);
    expect(apiKeys.revoke(db, adaUserId, disposable.id)).toBe(true);

    const revoked = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${disposable.token}`,
      },
      body: "{}",
    });
    expect(revoked.status).toBe(401);
    expect(await revoked.text()).not.toContain(disposable.token);

    const bobText = await toolText(port, bobKey, "list_accounts", {});
    expect(JSON.parse(bobText)).toMatchObject({ ok: true });
    expect(bobText).toContain(bobAccountId);
    expect(bobText).not.toContain(adaAccountId);
  });
});

async function toolText(port: number, token: string, name: string, args: Record<string, unknown>): Promise<string> {
  const client = new Client({ name: "openmail-isolation", version: "0.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  await client.connect(transport);
  try {
    const result = await client.callTool({ name, arguments: args });
    const content = result.content as { type: string; text?: string }[];
    const text = content.find((block) => block.type === "text")?.text;
    if (!text) throw new Error("missing tool text");
    return text;
  } finally {
    await client.close();
  }
}
