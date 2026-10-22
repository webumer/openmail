import { MESSAGE_SOURCE_CAP_BYTES } from "../src/mail/constants.js";
import { describe, expect, it } from "vitest";
import { MailError } from "../src/errors.js";
import { UNTRUSTED_CONTENT_WARNING } from "../src/mail/constants.js";
import { decodeCursor } from "../src/mail/cursor.js";
import type { ImapGateway } from "../src/mail/imap-gateway.js";
import {
  listAccounts,
  listFolders,
  readMessage,
  readThread,
  searchMessages,
} from "../src/mail/operations.js";
import type { CredentialStore } from "../src/store/types.js";
import { RecordingSession, SECRET, account, fetched, mailbox, textMail } from "./fixtures.js";

function harness(session = new RecordingSession()) {
  const modes: string[] = [];
  const imap: ImapGateway = {
    async withClient(_account, fn) {
      modes.push("client");
      return fn(session);
    },
    async withMailbox(_account, folder, fn) {
      modes.push(`mailbox:${folder}`);
      return fn(session);
    },
    async appendMessage() {
      return undefined;
    },
  };
  const store: CredentialStore = {
    async listAccounts() {
      return [{
        id: account.id,
        label: account.label,
        email: account.email,
        preset: account.preset,
        imapHost: account.imap.host,
        sendEnabled: false,
      }];
    },
    async getAccount(_userId, accountId) {
      if (accountId === "locked") {
        throw new MailError("missing_secret", "Environment variable OPENMAIL_ACCT_WORK_PASSWORD is not set for account locked");
      }
      return accountId === account.id ? account : null;
    },
  };
  return { deps: { store, imap }, modes, session, store };
}

describe("read-only mail operations", () => {
  it("lists accounts without secrets", async () => {
    const { store } = harness();
    const result = await listAccounts(store, "user-1");
    expect(result).toMatchObject({
      ok: true,
      truncated: false,
      data: [{ id: "work", label: "Work", email: "you@example.com", preset: "migadu", imap_host: "imap.migadu.com", sending_enabled: false }],
    });
    expect(JSON.stringify(result)).not.toContain(SECRET);
    expect(result.ok && result.warnings).toContain("This connection is read-only");
    const allowed = await listAccounts(store, "user-1", { canSend: true });
    expect(allowed.ok && allowed.warnings).toEqual([]);
    expect(await listAccounts(store, "  ")).toMatchObject({ ok: false, error: { code: "invalid_argument" } });
  });

  it("lists folders and fills missing STATUS counts", async () => {
    const { deps, modes, session } = harness();
    session.mailboxes = [
      mailbox({ path: "INBOX", name: "INBOX", specialUse: "\\Inbox", messages: 10, unseen: 1 }),
      mailbox({ path: "Archive", name: "Archive" }),
      mailbox({ path: "NoSelect", flags: ["\\Noselect"] }),
    ];
    const result = await listFolders(deps, "user-1", "work");
    expect(modes).toEqual(["client"]);
    expect(session.statusCalls).toEqual(["Archive"]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toEqual([
      { path: "INBOX", name: "INBOX", special_use: "\\Inbox", delimiter: "/", messages: 10, unseen: 1 },
      { path: "Archive", name: "Archive", special_use: null, delimiter: "/", messages: 4, unseen: 2 },
      { path: "NoSelect", name: "NoSelect", special_use: null, delimiter: "/", messages: null, unseen: null },
    ]);
  });

  it("skips STATUS fanout when too many folders lack counts", async () => {
    const { deps, session } = harness();
    session.mailboxes = Array.from({ length: 31 }, (_unused, index) => mailbox({ path: `F${index}` }));
    const result = await listFolders(deps, "user-1", "work");
    expect(session.statusCalls).toEqual([]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.warnings.some((warning) => warning.includes("STATUS"))).toBe(true);
  });

  it("searches newest-first and pages with a uid boundary", async () => {
    const { deps, modes, session } = harness();
    session.searchUids = [1, 5, 3];
    for (const uid of [1, 3, 5]) {
      session.messages.set(uid, fetched({
        uid,
        flags: uid === 5 ? ["\\Seen", "\\Flagged"] : ["\\Flagged"],
        size: uid * 10,
        envelope: {
          subject: `s${uid}`,
          messageId: `<${uid}@example.com>`,
          from: [{ name: "Ada", address: "ada@example.com" }],
          to: [{ address: "bo@example.com" }],
        },
        headers: Buffer.from("Date: Wed, 21 Oct 2026 18:19:00 +0500\r\n"),
        bodyStructure: { type: "text/plain" },
      }));
    }
    const first = await searchMessages(deps, "user-1", "work", {
      from: "ada@example.com",
      unread: true,
      limit: 1,
    });
    expect(modes).toEqual(["mailbox:INBOX"]);
    expect(session.searches[0]).toMatchObject({ from: "ada@example.com", seen: false });
    expect(session.fetches[0]?.source).toBeUndefined();
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.data.messages.map((message) => message.uid)).toEqual([5]);
    expect(first.data.messages[0]).toMatchObject({
      seen: true,
      has_attachments: false,
      subject: "s5",
      date: { utc: "2026-10-21T13:19:00.000Z", original_offset: "+05:00" },
    });
    expect(first.warnings).toContain(UNTRUSTED_CONTENT_WARNING);
    const cursor = first.data.next_cursor;
    expect(cursor).toBeTruthy();
    expect(decodeCursor(cursor ?? "").uid).toBe(5);

    const second = await searchMessages(deps, "user-1", "work", { limit: 1, cursor: cursor ?? "" });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.data.messages.map((message) => message.uid)).toEqual([3]);

    const third = await searchMessages(deps, "user-1", "work", { limit: 1, cursor: second.data.next_cursor ?? "" });
    expect(third.ok).toBe(true);
    if (!third.ok) return;
    expect(third.data.messages.map((message) => message.uid)).toEqual([1]);
    expect(third.data.next_cursor).toBeNull();
  });

  it("filters attachments on the client after the UID page boundary", async () => {
    const { deps, session } = harness();
    session.searchUids = [1, 3, 4, 5];
    const plain = { type: "text/plain" };
    const attached = {
      type: "multipart/mixed",
      childNodes: [{ type: "text/plain" }, { type: "application/pdf", disposition: "attachment" }],
    };
    for (const [uid, bodyStructure] of [[5, plain], [4, attached], [3, attached], [1, plain]] as const) {
      session.messages.set(uid, fetched({ uid, bodyStructure, envelope: { subject: String(uid) } }));
    }
    const page = await searchMessages(deps, "user-1", "work", { has_attachment: true, limit: 1 });
    expect(page.ok).toBe(true);
    if (!page.ok) return;
    expect(page.data.messages.map((message) => message.uid)).toEqual([4]);
    const next = await searchMessages(deps, "user-1", "work", {
      has_attachment: true,
      limit: 1,
      cursor: page.data.next_cursor ?? "",
    });
    expect(next.ok).toBe(true);
    if (!next.ok) return;
    expect(next.data.messages.map((message) => message.uid)).toEqual([3]);
  });

  it("rejects a bad limit or cursor before opening a mailbox", async () => {
    const { deps, modes } = harness();
    expect(await searchMessages(deps, "user-1", "work", { limit: 51 })).toMatchObject({
      ok: false,
      error: { code: "invalid_argument" },
    });
    expect(await searchMessages(deps, "user-1", "work", { cursor: "@@@@" })).toMatchObject({
      ok: false,
      error: { code: "invalid_cursor" },
    });
    expect(modes).toEqual([]);
    expect(await searchMessages(deps, "user-1", "missing", {})).toMatchObject({
      ok: false,
      error: { code: "not_found" },
    });
    expect(await listFolders(deps, "user-1", "locked")).toMatchObject({
      ok: false,
      error: { code: "missing_secret" },
    });
  });

  it("reads a message with PEEK source, stripped HTML, and no attachment bytes", async () => {
    const { deps, session } = harness();
    session.messages.set(9, fetched({
      uid: 9,
      flags: ["\\Flagged"],
      source: textMail({
        From: "Ada <ada@example.com>",
        To: "Bo <bo@example.com>",
        Subject: "Hello",
        Date: "Wed, 21 Oct 2026 18:19:00 +0500",
        "Message-ID": "<root@example.com>",
        "Content-Type": "text/html; charset=utf-8",
      }, "<p>Hello <b>world</b></p><script>ignore-this-token</script>"),
    }));
    const result = await readMessage(deps, "user-1", "work", "INBOX", 9);
    expect(session.fetches[0]?.source).toEqual({ maxLength: MESSAGE_SOURCE_CAP_BYTES });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.text).toContain("Hello");
    expect(result.data.text).not.toContain("ignore-this-token");
    expect(result.data.seen).toBe(false);
    expect(result.data.headers.date?.original_offset).toBe("+05:00");
    expect(result.data.attachments).toEqual([]);
    expect(JSON.stringify(result)).not.toContain(SECRET);
    expect(result.warnings).toContain(UNTRUSTED_CONTENT_WARNING);
  });

  it("caps a message body at 20000 characters", async () => {
    const { deps, session } = harness();
    session.messages.set(2, fetched({
      uid: 2,
      source: textMail({
        From: "Ada <ada@example.com>",
        To: "Bo <bo@example.com>",
        Subject: "Long",
        Date: "Wed, 21 Oct 2026 18:19:00 +0000",
        "Message-ID": "<long@example.com>",
        "Content-Type": "text/plain; charset=utf-8",
      }, "x".repeat(25_000)),
    }));
    const result = await readMessage(deps, "user-1", "work", "INBOX", 2);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.truncated).toBe(true);
    expect(result.data.text).toHaveLength(20_000);
    expect(result.warnings.some((warning) => warning.includes("20000"))).toBe(true);
  });

  it("builds a thread by header search, oldest first", async () => {
    const { deps, session } = harness();
    session.searchUids = [10, 11];
    session.messages.set(11, message(11, "<child@example.com>", "Wed, 21 Oct 2026 12:00:00 +0000", "child body", "<root@example.com>"));
    session.messages.set(10, message(10, "<root@example.com>", "Wed, 21 Oct 2026 10:00:00 +0000", "root body"));
    const result = await readThread(deps, "user-1", "work", "Sent", 11);
    expect(session.threadCalls).toBe(0);
    expect(session.searches.length).toBeGreaterThan(0);
    expect(session.searches[0]?.or).toEqual([
      { header: { "message-id": "<child@example.com>" } },
      { header: { "in-reply-to": "<child@example.com>" } },
      { header: { references: "<child@example.com>" } },
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.messages.map((item) => item.uid)).toEqual([10, 11]);
    expect(result.data.messages.map((item) => item.text.trim())).toEqual(["root body", "child body"]);
    expect(result.warnings).toContain(UNTRUSTED_CONTENT_WARNING);
  });

  it("uses the THREAD extension when the server advertises it", async () => {
    const { deps, session } = harness();
    session.capabilities.add("THREAD=REFS");
    session.threadResult = [11, 10];
    session.messages.set(11, message(11, "<child@example.com>", "Wed, 21 Oct 2026 12:00:00 +0000", "later"));
    session.messages.set(10, message(10, "<root@example.com>", "Wed, 21 Oct 2026 10:00:00 +0000", "earlier"));
    const result = await readThread(deps, "user-1", "work", "INBOX", 11);
    expect(session.threadCalls).toBe(1);
    expect(session.searches).toEqual([]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.messages.map((item) => item.text.trim())).toEqual(["earlier", "later"]);
  });

  it("caps the combined thread body at 40000 characters", async () => {
    const { deps, session } = harness();
    session.searchUids = [1, 2, 3];
    session.messages.set(1, message(1, "<a@example.com>", "Wed, 21 Oct 2026 10:00:00 +0000", "a".repeat(20_000)));
    session.messages.set(2, message(2, "<b@example.com>", "Wed, 21 Oct 2026 11:00:00 +0000", "b".repeat(20_000), "<a@example.com>"));
    session.messages.set(3, message(3, "<c@example.com>", "Wed, 21 Oct 2026 12:00:00 +0000", "c".repeat(20_000), "<a@example.com> <b@example.com>"));
    const result = await readThread(deps, "user-1", "work", "INBOX", 1);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.truncated).toBe(true);
    expect(result.data.messages[0]?.text).toHaveLength(20_000);
    expect(result.data.messages[1]?.text).toHaveLength(19_998);
    expect(result.data.messages[2]?.text).toBe("");
    const combined = result.data.messages.map((item) => item.text).filter((text) => text.length > 0).join("\n\n");
    expect(combined.length).toBeLessThanOrEqual(40_000);
  });
});

function message(uid: number, id: string, date: string, body: string, references?: string) {
  const headers: Record<string, string> = {
    From: "Ada <ada@example.com>",
    To: "Bo <bo@example.com>",
    Subject: id,
    Date: date,
    "Message-ID": id,
    "Content-Type": "text/plain; charset=utf-8",
  };
  if (references) {
    headers["In-Reply-To"] = references.split(" ")[0] ?? references;
    headers.References = references;
  }
  return fetched({
    uid,
    source: textMail(headers, body),
    envelope: { messageId: id, subject: id },
  });
}
