import net from "node:net";
import { ImapFlow } from "imapflow";
import nodemailer from "nodemailer";
import { beforeAll, describe, expect, it } from "vitest";
import { parseConfig } from "../../src/config/index.js";
import { BODY_CHAR_CAP, THREAD_CHAR_CAP, UNTRUSTED_CONTENT_WARNING } from "../../src/mail/constants.js";
import { createImapGateway } from "../../src/mail/imap-gateway.js";
import {
  listFolders,
  readMessage,
  readThread,
  searchMessages,
  type MailDeps,
  type SearchHit,
} from "../../src/mail/operations.js";
import type { ToolResult } from "../../src/mail/result.js";
import { ConfigCredentialStore } from "../../src/store/config-store.js";

const IMAP_PORT = Number(process.env.OPENMAIL_TEST_IMAP_PORT ?? "13143");
const SMTP_PORT = Number(process.env.OPENMAIL_TEST_SMTP_PORT ?? "13025");
const IMAP_USER = "test";
const IMAP_PASS = "test";
const ACCOUNT = "test";
const USER = "default";
const SEEDED = 15;

const live = (await probe(IMAP_PORT)) && (await probe(SMTP_PORT));
if (!live) {
  console.warn(
    `SKIP: GreenMail is unreachable at 127.0.0.1:${IMAP_PORT} (IMAP) and 127.0.0.1:${SMTP_PORT} (SMTP). Run npm run test:integration to start greenmail/standalone.`,
  );
}

describe.skipIf(!live)(
  live
    ? "GreenMail mail tools"
    : `SKIP: GreenMail is unreachable at 127.0.0.1:${IMAP_PORT} (IMAP) and 127.0.0.1:${SMTP_PORT} (SMTP). Run npm run test:integration`,
  () => {
    const run = `om${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const subjects = {
      plain: `${run} plain`,
      html: `${run} html`,
      attach: `${run} attach`,
      offset: `${run} offset`,
      huge: `${run} huge`,
      t1: `${run} thread 1`,
      t2: `${run} thread 2`,
      t3: `${run} thread 3`,
      big1: `${run} big 1`,
      big2: `${run} big 2`,
      page: (n: number) => `${run} page ${n}`,
    };
    const ids = {
      plain: `<${run}-plain@example.com>`,
      html: `<${run}-html@example.com>`,
      attach: `<${run}-attach@example.com>`,
      offset: `<${run}-offset@example.com>`,
      huge: `<${run}-huge@example.com>`,
      t1: `<${run}-t1@example.com>`,
      t2: `<${run}-t2@example.com>`,
      t3: `<${run}-t3@example.com>`,
      big1: `<${run}-big1@example.com>`,
      big2: `<${run}-big2@example.com>`,
    };
    const plainFrom = `plain-${run}@example.com`;
    const plainToken = `plain-token-${run}`;
    const hugeBody = `${"H".repeat(BODY_CHAR_CAP)}TAILMARKER`;
    const bigBody = "B".repeat(25_000);
    const deps = createDeps();
    const uids = new Map<string, number>();

    beforeAll(async () => {
      const transporter = nodemailer.createTransport({
        host: "127.0.0.1",
        port: SMTP_PORT,
        secure: false,
        ignoreTLS: true,
        auth: { user: IMAP_USER, pass: IMAP_PASS },
        connectionTimeout: 5_000,
        greetingTimeout: 5_000,
        socketTimeout: 20_000,
      });
      const send = async (raw: string) => {
        await transporter.sendMail({
          envelope: { from: "test@localhost", to: ["test@localhost"] },
          raw,
        });
      };

      await send(buildRaw({
        from: `Plain Sender <${plainFrom}>`,
        subject: subjects.plain,
        messageId: ids.plain,
        date: "Thu, 01 Jan 2026 00:00:00 +0000",
        text: plainToken,
      }));
      await send(buildRaw({
        from: "Html Sender <html@example.com>",
        subject: subjects.html,
        messageId: ids.html,
        date: "Thu, 01 Jan 2026 00:00:00 +0000",
        html: "<html><body><p>Hello <b>bold</b> world</p><script>ignore-me</script></body></html>",
      }));
      await send(buildRaw({
        from: "Attach Sender <attach@example.com>",
        subject: subjects.attach,
        messageId: ids.attach,
        date: "Thu, 01 Jan 2026 00:00:00 +0000",
        text: "see note",
        attachment: { filename: "note.txt", contentType: "text/plain", content: "attachment-bytes" },
      }));
      await send(buildRaw({
        from: "Offset Sender <offset@example.com>",
        subject: subjects.offset,
        messageId: ids.offset,
        date: "Wed, 15 Oct 2025 12:00:00 +0500",
        text: "offset body",
      }));
      await send(buildRaw({
        from: "Huge Sender <huge@example.com>",
        subject: subjects.huge,
        messageId: ids.huge,
        date: "Thu, 01 Jan 2026 00:00:00 +0000",
        text: hugeBody,
      }));
      await send(buildRaw({
        from: "Thread <thread@example.com>",
        subject: subjects.t3,
        messageId: ids.t3,
        date: "Sat, 03 Jan 2026 00:00:00 +0000",
        inReplyTo: ids.t2,
        references: [ids.t1, ids.t2],
        text: "third reply",
      }));
      await send(buildRaw({
        from: "Thread <thread@example.com>",
        subject: subjects.t1,
        messageId: ids.t1,
        date: "Thu, 01 Jan 2026 00:00:00 +0000",
        text: "first message",
      }));
      await send(buildRaw({
        from: "Thread <thread@example.com>",
        subject: subjects.t2,
        messageId: ids.t2,
        date: "Fri, 02 Jan 2026 00:00:00 +0000",
        inReplyTo: ids.t1,
        references: [ids.t1],
        text: "second reply",
      }));
      await send(buildRaw({
        from: "Big <big@example.com>",
        subject: subjects.big2,
        messageId: ids.big2,
        date: "Tue, 02 Jun 2026 00:00:00 +0000",
        inReplyTo: ids.big1,
        references: [ids.big1],
        text: "C".repeat(25_000),
      }));
      await send(buildRaw({
        from: "Big <big@example.com>",
        subject: subjects.big1,
        messageId: ids.big1,
        date: "Mon, 01 Jun 2026 00:00:00 +0000",
        text: bigBody,
      }));
      for (let n = 1; n <= 5; n += 1) {
        await send(buildRaw({
          from: "Page <page@example.com>",
          subject: subjects.page(n),
          messageId: `<${run}-page-${n}@example.com>`,
          date: "Thu, 01 Jan 2026 00:00:00 +0000",
          text: `page body ${n}`,
        }));
      }

      await waitForSeed(deps, run);
      const named: [string, string][] = [
        ["plain", subjects.plain],
        ["html", subjects.html],
        ["attach", subjects.attach],
        ["offset", subjects.offset],
        ["huge", subjects.huge],
        ["t1", subjects.t1],
        ["t2", subjects.t2],
        ["t3", subjects.t3],
        ["big1", subjects.big1],
        ["big2", subjects.big2],
      ];
      for (const [name, subject] of named) {
        uids.set(name, (await findOne(deps, subject)).uid);
      }
      await markSeen(uids.get("plain") ?? 0);
    }, 60_000);

    it("lists INBOX", async () => {
      const result = await listFolders(deps, USER, ACCOUNT);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const inbox = result.data.find((folder) => folder.path.toUpperCase() === "INBOX");
      expect(inbox).toMatchObject({ path: "INBOX", special_use: "\\Inbox" });
      expect(inbox?.messages).toBeGreaterThanOrEqual(SEEDED);
      expect(typeof inbox?.delimiter).toBe("string");
      expect(typeof inbox?.unseen).toBe("number");
    });

    it("filters search by from, subject, text, unread, attachment, and date", async () => {
      const from = await searchMessages(deps, USER, ACCOUNT, { from: plainFrom, subject: subjects.plain });
      expectOk(from);
      expect(from.data.messages).toHaveLength(1);
      expect(from.data.messages[0]?.subject).toBe(subjects.plain);
      expect(from.warnings).toContain(UNTRUSTED_CONTENT_WARNING);

      const subject = await searchMessages(deps, USER, ACCOUNT, { subject: subjects.html });
      expectOk(subject);
      expect(subject.data.messages.map((message) => message.subject)).toEqual([subjects.html]);

      const text = await searchMessages(deps, USER, ACCOUNT, { text: plainToken });
      expectOk(text);
      expect(text.data.messages.map((message) => message.subject)).toEqual([subjects.plain]);

      const unreadPlain = await searchMessages(deps, USER, ACCOUNT, { subject: subjects.plain, unread: true });
      expectOk(unreadPlain);
      expect(unreadPlain.data.messages).toHaveLength(0);

      const unreadHtml = await searchMessages(deps, USER, ACCOUNT, { subject: subjects.html, unread: true });
      expectOk(unreadHtml);
      expect(unreadHtml.data.messages).toHaveLength(1);
      expect(unreadHtml.data.messages[0]?.seen).toBe(false);

      const attached = await searchMessages(deps, USER, ACCOUNT, { subject: run, has_attachment: true, limit: 50 });
      expectOk(attached);
      expect(attached.data.messages.map((message) => message.subject)).toEqual([subjects.attach]);
      expect(attached.data.messages[0]?.has_attachments).toBe(true);

      const since = utcDay(-30);
      const included = await searchMessages(deps, USER, ACCOUNT, { subject: subjects.plain, since });
      expectOk(included);
      expect(included.data.messages).toHaveLength(1);

      const excluded = await searchMessages(deps, USER, ACCOUNT, { subject: subjects.plain, before: since });
      expectOk(excluded);
      expect(excluded.data.messages).toHaveLength(0);

      const future = await searchMessages(deps, USER, ACCOUNT, { subject: subjects.plain, since: utcDay(2) });
      expectOk(future);
      expect(future.data.messages).toHaveLength(0);
    });

    it("pages newest-first with an opaque cursor", async () => {
      const pages: SearchHit[][] = [];
      let cursor: string | undefined;
      for (let guard = 0; guard < 6; guard += 1) {
        const page = await searchMessages(deps, USER, ACCOUNT, { subject: `${run} page`, limit: 2, cursor });
        expectOk(page);
        pages.push(page.data.messages);
        if (!page.data.next_cursor) break;
        expect(page.data.messages.length).toBeGreaterThan(0);
        cursor = page.data.next_cursor;
      }
      expect(pages.map((page) => page.length)).toEqual([2, 2, 1]);
      const hits = pages.flat();
      const uidList = hits.map((hit) => hit.uid);
      expect(new Set(uidList).size).toBe(5);
      expect(uidList).toEqual([...uidList].sort((a, b) => b - a));
      expect(hits.map((hit) => hit.subject)).toEqual([5, 4, 3, 2, 1].map((n) => subjects.page(n)));
    });

    it("reads stripped text, attachments, headers, and the original date offset", async () => {
      const html = await readMessage(deps, USER, ACCOUNT, "INBOX", uid("html"));
      expectOk(html);
      expect(html.data.text).toMatch(/Hello/);
      expect(html.data.text).toMatch(/bold/);
      expect(html.data.text).not.toMatch(/<b>/);
      expect(html.data.text).not.toMatch(/ignore-me/);
      expect(html.data.attachments).toEqual([]);
      expect(html.data.headers.subject).toBe(subjects.html);
      expect(html.data.headers.message_id).toBe(ids.html);
      expect(html.data.seen).toBe(false);
      expect(html.warnings).toContain(UNTRUSTED_CONTENT_WARNING);

      const attached = await readMessage(deps, USER, ACCOUNT, "INBOX", uid("attach"));
      expectOk(attached);
      expect(attached.data.attachments).toEqual([
        {
          filename: "note.txt",
          content_type: expect.stringContaining("text/plain"),
          size: "attachment-bytes".length,
          content_id: null,
        },
      ]);
      expect(JSON.stringify(attached.data.attachments)).not.toContain("attachment-bytes");
      expect(attached.data.headers.from).toEqual([
        expect.objectContaining({ address: "attach@example.com" }),
      ]);

      const offset = await readMessage(deps, USER, ACCOUNT, "INBOX", uid("offset"));
      expectOk(offset);
      expect(offset.data.headers.date).toMatchObject({
        utc: "2025-10-15T07:00:00.000Z",
        original_offset: "+05:00",
      });
      expect(offset.data.headers.date?.original).toContain("+0500");
    });

    it("does not set \\Seen", async () => {
      const target = uid("html");
      const before = await flagsOf(target);
      expect(seen(before)).toBe(false);
      const result = await readMessage(deps, USER, ACCOUNT, "INBOX", target);
      expectOk(result);
      expect(result.data.seen).toBe(false);
      const after = await flagsOf(target);
      expect(seen(after)).toBe(false);
    });

    it("reads a thread oldest-first and caps the combined body at 40,000 characters", async () => {
      const thread = await readThread(deps, USER, ACCOUNT, "INBOX", uid("t3"));
      expectOk(thread);
      expect(thread.data.seed_uid).toBe(uid("t3"));
      expect(thread.data.messages.map((message) => message.headers.subject)).toEqual([
        subjects.t1,
        subjects.t2,
        subjects.t3,
      ]);
      expect(thread.data.messages[1]?.headers.in_reply_to).toBe(ids.t1);
      expect(thread.data.messages[2]?.headers.in_reply_to).toBe(ids.t2);
      expect(thread.data.messages[2]?.headers.references).toEqual(expect.arrayContaining([ids.t1, ids.t2]));
      expect(thread.data.messages.every((message) => message.seen === false)).toBe(true);

      const capped = await readThread(deps, USER, ACCOUNT, "INBOX", uid("big2"));
      expectOk(capped);
      expect(capped.truncated).toBe(true);
      expect(capped.warnings.some((warning) => warning.includes(String(THREAD_CHAR_CAP)))).toBe(true);
      expect(capped.data.messages.map((message) => message.headers.subject)).toEqual([subjects.big1, subjects.big2]);
      const lengths = capped.data.messages.map((message) => message.text.length);
      expect(lengths[0]).toBeGreaterThan(BODY_CHAR_CAP);
      expect(lengths[1]).toBeLessThan(25_000);
      expect(lengths.reduce((sum, length) => sum + length, 0)).toBeLessThanOrEqual(THREAD_CHAR_CAP);
    });

    it("truncates a body over 20,000 characters", async () => {
      const result = await readMessage(deps, USER, ACCOUNT, "INBOX", uid("huge"));
      expectOk(result);
      expect(result.truncated).toBe(true);
      expect(result.data.text).toHaveLength(BODY_CHAR_CAP);
      expect(result.data.text.includes("TAILMARKER")).toBe(false);
      expect(result.warnings.some((warning) => warning.includes(String(BODY_CHAR_CAP)))).toBe(true);
    });

    function uid(name: string): number {
      const value = uids.get(name);
      if (!value) throw new Error(`missing uid for ${name}`);
      return value;
    }
  },
);

function createDeps(): MailDeps {
  const config = parseConfig({
    allow_insecure_localhost: true,
    accounts: [
      {
        id: ACCOUNT,
        label: "Test",
        email: "test@example.com",
        preset: "custom",
        password_env: "OPENMAIL_ACCT_TEST_PASSWORD",
        username: IMAP_USER,
        imap_host: "127.0.0.1",
        imap_port: IMAP_PORT,
        imap_secure: false,
        smtp_host: "127.0.0.1",
        smtp_port: SMTP_PORT,
        smtp_secure: false,
      },
    ],
  });
  return {
    store: new ConfigCredentialStore(config, { OPENMAIL_ACCT_TEST_PASSWORD: IMAP_PASS }),
    imap: createImapGateway(),
  };
}

async function findOne(deps: MailDeps, subject: string): Promise<SearchHit> {
  const result = await searchMessages(deps, USER, ACCOUNT, { subject, limit: 10 });
  expectOk(result);
  expect(result.data.messages).toHaveLength(1);
  const hit = result.data.messages[0];
  if (!hit) throw new Error(`missing ${subject}`);
  return hit;
}

async function waitForSeed(deps: MailDeps, run: string): Promise<void> {
  const deadline = Date.now() + 20_000;
  let last = "none";
  while (Date.now() < deadline) {
    const result = await searchMessages(deps, USER, ACCOUNT, { subject: run, limit: 50 });
    if (result.ok && result.data.messages.length >= SEEDED) return;
    last = result.ok ? String(result.data.messages.length) : result.error.message;
    await delay(200);
  }
  throw new Error(`Timed out waiting for ${SEEDED} seeded messages (last: ${last})`);
}

async function markSeen(uid: number): Promise<void> {
  await withImap(async (client) => {
    const lock = await client.getMailboxLock("INBOX");
    try {
      await client.messageFlagsAdd(String(uid), ["\\Seen"], { uid: true });
    } finally {
      lock.release();
    }
  });
}

async function flagsOf(uid: number): Promise<string[]> {
  return withImap(async (client) => {
    const lock = await client.getMailboxLock("INBOX", { readOnly: true });
    try {
      const message = await client.fetchOne(String(uid), { flags: true, uid: true }, { uid: true });
      if (!message) throw new Error(`uid ${uid} not found`);
      return [...(message.flags ?? [])];
    } finally {
      lock.release();
    }
  });
}

async function withImap<T>(fn: (client: ImapFlow) => Promise<T>): Promise<T> {
  const client = new ImapFlow({
    host: "127.0.0.1",
    port: IMAP_PORT,
    secure: false,
    doSTARTTLS: false,
    auth: { user: IMAP_USER, pass: IMAP_PASS },
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

function seen(flags: readonly string[]): boolean {
  return flags.some((flag) => flag.toLowerCase() === "\\seen");
}

function expectOk<T>(result: ToolResult<T>): asserts result is Extract<ToolResult<T>, { ok: true }> {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
}

function utcDay(offsetDays: number): string {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + offsetDays);
  return date.toISOString().slice(0, 10);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function probe(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port, family: 4 });
    const finish = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(1_000);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

interface Outgoing {
  from: string;
  subject: string;
  messageId: string;
  date: string;
  inReplyTo?: string;
  references?: string[];
  text?: string;
  html?: string;
  attachment?: { filename: string; contentType: string; content: string };
}

function buildRaw(message: Outgoing): string {
  const headers = [
    `From: ${message.from}`,
    "To: Test <test@localhost>",
    `Subject: ${message.subject}`,
    `Date: ${message.date}`,
    `Message-ID: ${message.messageId}`,
    "MIME-Version: 1.0",
  ];
  if (message.inReplyTo) headers.push(`In-Reply-To: ${message.inReplyTo}`);
  if (message.references && message.references.length > 0) {
    headers.push(`References: ${message.references.join(" ")}`);
  }
  if (message.attachment && message.text !== undefined) {
    const boundary = `b${message.messageId.replace(/[^A-Za-z0-9]/g, "")}`;
    headers.push(`Content-Type: multipart/mixed; boundary="${boundary}"`);
    const body = [
      `--${boundary}`,
      "Content-Type: text/plain; charset=utf-8",
      "",
      message.text,
      `--${boundary}`,
      `Content-Type: ${message.attachment.contentType}`,
      `Content-Disposition: attachment; filename="${message.attachment.filename}"`,
      "",
      message.attachment.content,
      `--${boundary}--`,
      "",
    ].join("\r\n");
    return `${headers.join("\r\n")}\r\n\r\n${body}`;
  }
  if (message.html !== undefined) {
    headers.push("Content-Type: text/html; charset=utf-8");
    return `${headers.join("\r\n")}\r\n\r\n${message.html}`;
  }
  headers.push("Content-Type: text/plain; charset=utf-8");
  return `${headers.join("\r\n")}\r\n\r\n${message.text ?? ""}`;
}
