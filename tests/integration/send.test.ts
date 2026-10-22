import { once } from "node:events";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import net from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import nodemailer from "nodemailer";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generateTestMasterKey, loadMasterKey } from "../../src/crypto/index.js";
import { migrate, openDatabase } from "../../src/db/index.js";
import { createImapGateway } from "../../src/mail/imap-gateway.js";
import { sendMessage } from "../../src/mail/send.js";
import { createSmtpGateway } from "../../src/mail/smtp-gateway.js";
import { authenticateDatabaseKey, createOpenMailServer } from "../../src/server/index.js";
import { apiKeys, mailAccounts, users } from "../../src/services/index.js";
import { createSqliteSendRecorder } from "../../src/services/send-log.js";
import { SqliteCredentialStore } from "../../src/store/sqlite-store.js";

const IMAP_PORT = Number(process.env.OPENMAIL_TEST_IMAP_PORT ?? "13143");
const SMTP_PORT = Number(process.env.OPENMAIL_TEST_SMTP_PORT ?? "13025");
const live = (await probe(IMAP_PORT)) && (await probe(SMTP_PORT));

describe.skipIf(!live)("GreenMail sending", () => {
  const run = `send${Date.now().toString(36)}`;
  const subject = `${run} original`;
  const messageId = `<${run}@demo.openmail.tools>`;
  let db: ReturnType<typeof openDatabase>;
  let store: SqliteCredentialStore;
  let userId = "";
  let accountId = "";
  let originalUid = 0;
  let server: Server | undefined;

  beforeAll(async () => {
    const master = loadMasterKey(generateTestMasterKey());
    db = openDatabase(":memory:");
    migrate(db);
    const user = await users.create(db, master, { email: "ada@example.com", password: "correct-horse" });
    userId = user.id;
    const added = mailAccounts.add(db, master, {
      userId,
      name: "Test",
      email: "test@example.com",
      username: "test",
      preset: "custom",
      password: "test",
      imapHost: "127.0.0.1",
      imapPort: IMAP_PORT,
      imapSecure: false,
      smtpHost: "127.0.0.1",
      smtpPort: SMTP_PORT,
      smtpSecure: false,
      smtpStarttls: false,
    });
    accountId = added.id;
    mailAccounts.setSendEnabled(db, userId, accountId, true);
    store = new SqliteCredentialStore(db, master, { allowInsecureLocalhost: true });
    await withUser("test", "test", async (client) => {
      await client.mailboxCreate("Sent").catch(() => undefined);
    });
    await deliverOriginal(subject, messageId);
    originalUid = await findUid("test", "test", "INBOX", subject);
  });

  afterAll(async () => {
    if (server) await new Promise<void>((resolve) => server?.close(() => resolve()));
    db?.close();
  });

  it("delivers a reply with threading headers, leaves the original unseen, and saves a seen Sent copy", async () => {
    const result = await sendMessage(sendDeps(), userId, {
      account: accountId,
      body: `reply ${run}`,
      reply_to: { folder: "INBOX", uid: originalUid, mode: "reply", quote_original: true, include_attachments: true },
      user_confirmed: true,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.in_reply_to).toBe(messageId);
    expect(result.data.sent_copy.saved).toBe(true);

    const delivered = await waitForSource("test", "test", `Re: ${subject}`);
    const parsed = await simpleParser(delivered);
    expect(parsed.inReplyTo).toBe(messageId);
    expect(String(parsed.references)).toContain(messageId);
    expect(parsed.text).toContain(`reply ${run}`);

    const flags = await flagsOf("test", "test", "INBOX", originalUid);
    expect(flags.some((flag) => flag.toLowerCase() === "\\seen")).toBe(false);

    const sentUid = await findUid("test", "test", "Sent", `Re: ${subject}`);
    const sentFlags = await flagsOf("test", "test", "Sent", sentUid);
    expect(sentFlags.some((flag) => flag.toLowerCase() === "\\seen")).toBe(true);
  });

  it("does not deliver when sending is off or the key is read-only", async () => {
    mailAccounts.setSendEnabled(db, userId, accountId, false);
    const disabled = await sendMessage(sendDeps(), userId, {
      account: accountId,
      to: ["test@localhost"],
      subject: `${run} blocked`,
      body: "no",
      user_confirmed: true,
    });
    expect(disabled.ok).toBe(false);
    if (!disabled.ok) expect(disabled.error.code).toBe("sending_disabled");
    mailAccounts.setSendEnabled(db, userId, accountId, true);
    const readOnly = await sendMessage({ ...sendDeps(), canSend: false }, userId, {
      account: accountId,
      to: ["test@localhost"],
      subject: `${run} readonly`,
      body: "no",
      user_confirmed: true,
    });
    expect(readOnly.ok).toBe(false);
    if (!readOnly.ok) expect(readOnly.error.code).toBe("send_not_permitted");
    expect(await countSubject("test", "test", "INBOX", `${run} blocked`)).toBe(0);
    expect(await countSubject("test", "test", "INBOX", `${run} readonly`)).toBe(0);
  });

  it("sends through MCP over HTTP with an API key that can send", async () => {
    const key = apiKeys.create(db, { userId, name: "Sender", canSend: true });
    const readOnly = apiKeys.create(db, { userId, name: "Reader", canSend: false });
    server = createOpenMailServer({
      store,
      imap: createImapGateway(),
      smtp: createSmtpGateway(),
      sends: createSqliteSendRecorder(db),
      authenticate: (header) => authenticateDatabaseKey(db, header),
      publicUrl: "https://openmail.example",
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const port = (server.address() as AddressInfo).port;
    const denied = await callSend(port, readOnly.token, `${run} mcp denied`);
    expect(denied.ok).toBe(false);
    const sent = await callSend(port, key.token, `${run} mcp sent`);
    expect(sent.ok).toBe(true);
    const source = await waitForSource("test", "test", `${run} mcp sent`);
    expect(source.toString("utf8")).toContain(`${run} mcp sent`);
  });

  function sendDeps() {
    return {
      store,
      imap: createImapGateway(),
      smtp: createSmtpGateway(),
      sends: createSqliteSendRecorder(db),
      canSend: true,
      via: "api_key:test",
      publicUrl: "https://openmail.example",
    };
  }
});

async function deliverOriginal(subject: string, messageId: string): Promise<void> {
  const transport = nodemailer.createTransport({
    host: "127.0.0.1",
    port: SMTP_PORT,
    secure: false,
    ignoreTLS: true,
    auth: { user: "test", pass: "test" },
    connectionTimeout: 5_000,
    greetingTimeout: 5_000,
    socketTimeout: 20_000,
  });
  const raw = [
    "From: Demo <test@localhost>",
    "To: test@example.com",
    `Subject: ${subject}`,
    `Message-ID: ${messageId}`,
    "Date: Tue, 1 Jan 2026 00:00:00 +0000",
    "Content-Type: text/plain; charset=utf-8",
    "",
    "original text",
  ].join("\r\n");
  await transport.sendMail({ envelope: { from: "test@localhost", to: ["test@localhost"] }, raw });
  transport.close();
}

async function callSend(port: number, token: string, subject: string): Promise<{ ok: boolean }> {
  const client = new Client({ name: "send-test", version: "0" });
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  });
  await client.connect(transport);
  try {
    const result = await client.callTool({
      name: "send_message",
      arguments: {
        account: "Test",
        to: ["test@localhost"],
        subject,
        body: subject,
        user_confirmed: true,
      },
    });
    const text = (result.content as { type: string; text?: string }[]).find((block) => block.type === "text")?.text ?? "";
    return JSON.parse(text) as { ok: boolean };
  } finally {
    await client.close();
  }
}

async function waitForSource(user: string, pass: string, subject: string): Promise<Buffer> {
  let last = "";
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const found = await withUser(user, pass, async (client) => {
      const lock = await client.getMailboxLock("INBOX", { readOnly: true });
      try {
        const uids = asUids(await client.search({ subject }, { uid: true }));
        const uid = uids.at(-1);
        if (!uid) return null;
        const message = await client.fetchOne(String(uid), { source: true, uid: true }, { uid: true });
        return message && message.source ? Buffer.from(message.source) : null;
      } finally {
        lock.release();
      }
    });
    if (found) return found;
    last = subject;
    await delay(250);
  }
  throw new Error(`message not delivered: ${last}`);
}

async function findUid(user: string, pass: string, folder: string, subject: string): Promise<number> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const uid = await withUser(user, pass, async (client) => {
      const lock = await client.getMailboxLock(folder, { readOnly: true });
      try {
        const uids = asUids(await client.search({ subject }, { uid: true }));
        return uids.at(-1) ?? 0;
      } finally {
        lock.release();
      }
    });
    if (uid) return uid;
    await delay(250);
  }
  throw new Error(`uid not found for ${subject}`);
}

async function countSubject(user: string, pass: string, folder: string, subject: string): Promise<number> {
  return withUser(user, pass, async (client) => {
    const lock = await client.getMailboxLock(folder, { readOnly: true });
    try {
      return asUids(await client.search({ subject }, { uid: true })).length;
    } finally {
      lock.release();
    }
  });
}

async function flagsOf(user: string, pass: string, folder: string, uid: number): Promise<string[]> {
  return withUser(user, pass, async (client) => {
    const lock = await client.getMailboxLock(folder, { readOnly: true });
    try {
      const message = await client.fetchOne(String(uid), { flags: true, uid: true }, { uid: true });
      return [...(message && message.flags ? message.flags : [])];
    } finally {
      lock.release();
    }
  });
}

async function withUser<T>(user: string, pass: string, fn: (client: ImapFlow) => Promise<T>): Promise<T> {
  const client = new ImapFlow({
    host: "127.0.0.1",
    port: IMAP_PORT,
    secure: false,
    doSTARTTLS: false,
    auth: { user, pass },
    logger: false,
    tls: { rejectUnauthorized: true },
  });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.logout().catch(() => client.close());
  }
}

function asUids(value: false | number[] | undefined): number[] {
  return Array.isArray(value) ? value : [];
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function probe(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port, family: 4 });
    const finish = (ok: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(1000);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}
