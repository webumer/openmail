import { simpleParser } from "mailparser";
import { describe, expect, it } from "vitest";
import { MailError, toSmtpError } from "../src/errors.js";
import { resolveHostTarget } from "../src/mail/address-guard.js";
import {
  forwardSubject,
  parseOneAddress,
  quoteOriginal,
  replySubject,
  resolveRecipients,
} from "../src/mail/compose.js";
import type { ImapGateway } from "../src/mail/imap-gateway.js";
import { listAccounts } from "../src/mail/operations.js";
import { findSentFolder, sendMessage, type SendDeps } from "../src/mail/send.js";
import type { SmtpGateway, SmtpMessage } from "../src/mail/smtp-gateway.js";
import { buildSmtpConnectOptions } from "../src/mail/tls.js";
import { createMemorySendRecorder, createSqliteSendRecorder } from "../src/services/send-log.js";
import { migrate, openDatabase } from "../src/db/index.js";
import { generateTestMasterKey, loadMasterKey } from "../src/crypto/index.js";
import { apiKeys, mailAccounts, users } from "../src/services/index.js";
import { authenticateDatabaseKey } from "../src/server/db-auth.js";
import { SqliteCredentialStore } from "../src/store/sqlite-store.js";
import type { ImapSession, ListedMailbox } from "../src/mail/session.js";
import type { AccountCredentials, CredentialStore } from "../src/store/types.js";
import { account } from "./fixtures.js";

function folder(path: string, specialUse: string | null = null): ListedMailbox {
  return { path, name: path, delimiter: "/", specialUse, flags: specialUse ? [specialUse] : [], messages: null, unseen: null };
}

function session(list: ListedMailbox[] = [folder("Sent", "\\Sent")]): ImapSession {
  return {
    capabilities: new Set(),
    list: async () => list,
    status: async () => null,
    search: async () => [],
    fetchOne: async () => null,
    fetchAll: async () => [],
  };
}

const LIMITS = { perHour: 20, perDay: 100, maxRecipients: 20 };

function mailbox(overrides: Partial<AccountCredentials> = {}): AccountCredentials {
  return {
    ...account,
    sendEnabled: true,
    ...overrides,
    smtpAuth: overrides.smtpAuth ?? account.smtpAuth,
  };
}

function deps(options: {
  account?: AccountCredentials | null;
  accounts?: AccountCredentials[];
  smtp?: SmtpGateway;
  imap?: ImapGateway;
  canSend?: boolean;
  limits?: typeof LIMITS;
  userId?: string;
}): { deps: SendDeps; sent: SmtpMessage[]; appended: { folder: string; flags: string[] }[] } {
  const sent: SmtpMessage[] = [];
  const appended: { folder: string; flags: string[] }[] = [];
  const known = options.accounts ?? (options.account === null ? [] : [options.account ?? mailbox()]);
  const store: CredentialStore = {
    async listAccounts(userId) {
      if (options.userId && userId !== options.userId) return [];
      return known.map((item) => ({
        id: item.id,
        label: item.label,
        email: item.email,
        preset: item.preset,
        imapHost: item.imap.host,
        sendEnabled: item.sendEnabled,
      }));
    },
    async getAccount(userId, accountId) {
      if (options.userId && userId !== options.userId) return null;
      return known.find((item) => item.id === accountId || item.label === accountId) ?? null;
    },
  };
  const imap: ImapGateway = options.imap ?? {
    async withClient(_account, fn) {
      return fn(session());
    },
    async withMailbox() {
      throw new Error("no mailbox");
    },
    async appendMessage(_account, folder, _raw, flags) {
      appended.push({ folder, flags });
    },
  };
  const smtp: SmtpGateway = options.smtp ?? {
    async send(_account, message) {
      sent.push(message);
      return { messageId: "queued" };
    },
    async verify() {
      return undefined;
    },
  };
  return {
    sent,
    appended,
    deps: {
      store,
      imap,
      smtp,
      sends: createMemorySendRecorder(),
      canSend: options.canSend ?? true,
      via: "api_key:Laptop",
      publicUrl: "https://openmail.example",
      limits: options.limits ?? LIMITS,
    },
  };
}

const baseInput = {
  account: account.id,
  to: ["pat@example.com"],
  subject: "Hello",
  body: "See you there.",
  user_confirmed: true as const,
};

describe("address and header checks", () => {
  it("rejects control characters, groups, and too many recipients", async () => {
    const harness = deps({});
    const cases = [
      { ...baseInput, to: ["pat@example.com\r\nBcc: evil@example.com"] },
      { ...baseInput, subject: "Hello\nBcc: evil@example.com" },
      { ...baseInput, from_name: "Ann\rSmith" },
      { ...baseInput, cc: ["ok@example.com\u0000"] },
      { ...baseInput, to: ["Team: pat@example.com;"] },
      { ...baseInput, to: Array.from({ length: 21 }, (_, i) => `p${i}@example.com`) },
    ];
    for (const input of cases) {
      const result = await sendMessage(harness.deps, "user", input);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe("invalid_argument");
    }
    expect(harness.sent).toHaveLength(0);
    expect(parseOneAddress("Pat <pat@example.com>")).toBe("pat@example.com");
    const deduped = resolveRecipients({
      mode: "new",
      accountEmail: "you@example.com",
      to: ["Pat@Example.com", "pat@example.com"],
      cc: ["pat@example.com"],
      maxRecipients: 20,
    });
    expect(deduped.to.map((item) => item.toLowerCase())).toEqual(["pat@example.com"]);
    expect(deduped.cc).toEqual([]);
  });
});

describe("reply and forward", () => {
  it("does not stack Re:, threads the reply, and drops the mailbox from reply-all", () => {
    expect(replySubject("Re: Hello")).toBe("Re: Hello");
    expect(replySubject("RE: Aw: Hello")).toBe("Re: Hello");
    expect(forwardSubject("Fwd: Hello")).toBe("Fwd: Hello");
    expect(forwardSubject("Hello")).toBe("Fwd: Hello");
    const replyAll = resolveRecipients({
      mode: "reply_all",
      accountEmail: "you@example.com",
      original: {
        from: ["Pat <pat@example.com>"],
        to: ["you@example.com", "other@example.com"],
        cc: ["cc@example.com", "pat@example.com"],
        replyTo: [],
      },
      maxRecipients: 20,
    });
    expect(replyAll.to).toEqual(["pat@example.com"]);
    expect(replyAll.cc.sort()).toEqual(["cc@example.com", "other@example.com"]);
    expect(quoteOriginal("Tue", "Pat", "line").startsWith("\n\nOn Tue, Pat wrote:\n> line")).toBe(true);
  });

  it("sends a threaded reply and a forward without marking the original seen", async () => {
    const source = Buffer.from(
      [
        "From: Pat <pat@example.com>",
        "To: you@example.com, other@example.com",
        "Cc: cc@example.com",
        "Message-ID: <orig@example.com>",
        "References: <old@example.com>",
        "Subject: Re: Hello",
        "Date: Tue, 1 Jan 2026 00:00:00 +0000",
        "Content-Type: text/plain; charset=utf-8",
        "",
        "Original body",
      ].join("\r\n"),
    );
    let examined = false;
    const harness = deps({
      imap: {
        async withClient(_account, fn) {
          return fn(session());
        },
        async withMailbox(_account, folderName, fn) {
          examined = folderName === "INBOX";
          return fn({
            ...session([]),
            fetchOne: async () => ({
              uid: 4,
              source,
              flags: [],
              size: source.length,
              envelope: null,
              bodyStructure: null,
              internalDate: null,
              headers: null,
            }),
          });
        },
        async appendMessage() {
          return undefined;
        },
      },
    });
    const reply = await sendMessage(harness.deps, "user", {
      account: account.id,
      body: "Thanks",
      reply_to: { folder: "INBOX", uid: 4, mode: "reply", quote_original: true, include_attachments: true },
      user_confirmed: true,
    });
    expect(examined).toBe(true);
    expect(reply.ok).toBe(true);
    const parsed = await simpleParser(harness.sent[0]?.raw ?? Buffer.alloc(0));
    expect(parsed.subject).toBe("Re: Hello");
    expect(parsed.inReplyTo).toBe("<orig@example.com>");
    expect(parsed.references).toContain("<old@example.com>");
    expect(parsed.references).toContain("<orig@example.com>");
    const toText = Array.isArray(parsed.to) ? parsed.to.map((item) => item.text).join(",") : (parsed.to?.text ?? "");
    expect(toText).toContain("pat@example.com");
    expect(parsed.text).toContain("Thanks");
    expect(parsed.text).toContain("> Original body");

    harness.sent.length = 0;
    const forwarded = await sendMessage(harness.deps, "user", {
      account: account.id,
      to: ["new@example.com"],
      body: "FYI",
      reply_to: { folder: "INBOX", uid: 4, mode: "forward", quote_original: true, include_attachments: false },
      user_confirmed: true,
    });
    expect(forwarded.ok).toBe(true);
    const fwd = await simpleParser(harness.sent[0]?.raw ?? Buffer.alloc(0));
    expect(fwd.subject).toBe("Fwd: Re: Hello");
    expect(fwd.inReplyTo).toBeUndefined();
    expect(fwd.text).toContain("Forwarded message");
  });
});

describe("permission and isolation", () => {
  it("refuses a read-only connection and a mailbox with sending off", async () => {
    const readOnly = deps({ canSend: false });
    const denied = await sendMessage(readOnly.deps, "user", baseInput);
    expect(denied.ok).toBe(false);
    if (!denied.ok) {
      expect(denied.error.code).toBe("send_not_permitted");
      expect(denied.error.message).toContain("https://openmail.example/dashboard");
    }
    const off = deps({ account: mailbox({ sendEnabled: false }) });
    const disabled = await sendMessage(off.deps, "user", baseInput);
    expect(disabled.ok).toBe(false);
    if (!disabled.ok) expect(disabled.error.code).toBe("sending_disabled");
    expect(readOnly.sent).toHaveLength(0);
    expect(off.sent).toHaveLength(0);
  });

  it("does not send from another user's account id", async () => {
    const harness = deps({ userId: "alice" });
    const result = await sendMessage(harness.deps, "bob", baseInput);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("not_found");
    expect(harness.sent).toHaveLength(0);
  });

  it("marks a read-only connection on list_accounts", async () => {
    const harness = deps({ canSend: false });
    const listed = await listAccounts(harness.deps.store, "user", { canSend: false });
    expect(listed.ok).toBe(true);
    if (listed.ok) {
      expect(listed.data[0]?.sending_enabled).toBe(true);
      expect(listed.warnings).toContain("This connection is read-only");
    }
  });
});

describe("rate limits and the send log", () => {
  it("counts sent and failed attempts for the user and the mailbox", async () => {
    const failing: SmtpGateway = {
      async send() {
        throw new Error("550 rejected");
      },
      async verify() {
        return undefined;
      },
    };
    const harness = deps({
      smtp: failing,
      limits: { perHour: 2, perDay: 3, maxRecipients: 20 },
      accounts: [mailbox(), mailbox({ id: "other", label: "Other" })],
    });
    const first = await sendMessage(harness.deps, "user", baseInput);
    const second = await sendMessage(harness.deps, "user", { ...baseInput, account: "other" });
    const third = await sendMessage(harness.deps, "user", baseInput);
    expect(first.ok).toBe(false);
    expect(second.ok).toBe(false);
    expect(third.ok).toBe(false);
    if (!third.ok) {
      expect(third.error.code).toBe("rate_limited");
      expect(third.error.message).toMatch(/Try again after /);
    }
  });

  it("stores no body, subject, or address", async () => {
    const db = openDatabase(":memory:");
    migrate(db);
    const master = loadMasterKey(generateTestMasterKey());
    const user = await users.create(db, master, { email: "ada@example.com", password: "correct-horse" });
    const added = mailAccounts.add(db, master, {
      userId: user.id,
      name: "Work",
      email: "you@example.com",
      preset: "migadu",
      password: "mailbox-secret",
    });
    mailAccounts.setSendEnabled(db, user.id, added.id, true);
    const store = new SqliteCredentialStore(db, master);
    const recorder = createSqliteSendRecorder(db);
    const result = await sendMessage(
      {
        store,
        imap: {
          async withClient(_account, fn) {
            return fn(session([]));
          },
          async withMailbox() {
            throw new Error("no");
          },
          async appendMessage() {
            return undefined;
          },
        },
        smtp: {
          async send() {
            return { messageId: "m" };
          },
          async verify() {
            return undefined;
          },
        },
        sends: recorder,
        canSend: true,
        via: "api_key:Laptop",
        limits: LIMITS,
      },
      user.id,
      { account: added.id, to: ["hidden@example.com"], subject: "Secret subject", body: "Secret body", user_confirmed: true },
    );
    expect(result.ok).toBe(true);
    const row = db.prepare("SELECT * FROM send_log").get() as Record<string, unknown>;
    const dumped = JSON.stringify(row);
    expect(dumped).not.toContain("Secret subject");
    expect(dumped).not.toContain("Secret body");
    expect(dumped).not.toContain("hidden@example.com");
    expect(row.status).toBe("sent");
    db.close();
  });
});

describe("SMTP transport", () => {
  it("always verifies TLS, requires STARTTLS on 587, and refuses plain public hosts", () => {
    const implicit = buildSmtpConnectOptions(mailbox({ smtp: { host: "smtp.example.com", port: 465, secure: false, starttls: false } }));
    expect(implicit.secure).toBe(true);
    expect(implicit.tls.rejectUnauthorized).toBe(true);
    const starttls = buildSmtpConnectOptions(mailbox({ smtp: { host: "smtp.example.com", port: 587, secure: false, starttls: true } }));
    expect(starttls.secure).toBe(false);
    expect(starttls.requireTLS).toBe(true);
    expect(starttls.tls.rejectUnauthorized).toBe(true);
    expect(() =>
      buildSmtpConnectOptions(mailbox({ smtp: { host: "smtp.example.com", port: 3025, secure: false, starttls: false } })),
    ).toThrow(MailError);
    const plain = buildSmtpConnectOptions(
      mailbox({
        allowInsecureLocalhost: true,
        smtp: { host: "127.0.0.1", port: 13025, secure: false, starttls: false },
      }),
    );
    expect(plain.ignoreTLS).toBe(true);
    expect(plain.secure).toBe(false);
  });

  it("refuses a private address and scrubs the password out of errors", async () => {
    await expect(
      resolveHostTarget(
        { host: "smtp.example.com", allowInsecureLocalhost: false, protocol: "SMTP" },
        async () => ["10.1.2.3"],
      ),
    ).rejects.toMatchObject({ code: "blocked_host" });
    const error = toSmtpError(new Error("login failed for mailbox-secret-value"), ["mailbox-secret-value"]);
    expect(error.message).not.toContain("mailbox-secret-value");
    expect(error.code).toBe("smtp_error");
    expect(["Could not reach the SMTP server", "SMTP sign-in failed", "TLS verification failed for the SMTP server", "The SMTP server rejected the message"]).toContain(error.message);
  });
});

describe("sent copy", () => {
  it("skips APPEND for Gmail and appends with \\Seen otherwise", async () => {
    const gmail = deps({ account: mailbox({ preset: "gmail", autoSavesSent: true }) });
    const sent = await sendMessage(gmail.deps, "user", baseInput);
    expect(sent.ok).toBe(true);
    if (sent.ok) {
      expect(sent.data.sent_copy).toEqual({ saved: false, folder: null });
      expect(sent.data.warnings.join(" ")).toContain("own Sent copy");
    }
    expect(gmail.appended).toHaveLength(0);

    const saved = deps({});
    const copy = await sendMessage(saved.deps, "user", baseInput);
    expect(copy.ok).toBe(true);
    expect(saved.appended).toEqual([{ folder: "Sent", flags: ["\\Seen"] }]);
    expect(findSentFolder([folder("INBOX.Sent")])?.path).toBe("INBOX.Sent");
  });
});

describe("api key principal", () => {
  it("reports canSend from the key", async () => {
    const db = openDatabase(":memory:");
    migrate(db);
    const master = loadMasterKey(generateTestMasterKey());
    const user = await users.create(db, master, { email: "ada@example.com", password: "correct-horse" });
    const key = apiKeys.create(db, { userId: user.id, name: "Bot", canSend: true });
    const principal = authenticateDatabaseKey(db, `Bearer ${key.token}`);
    expect(principal).toMatchObject({ userId: user.id, canSend: true, via: "api_key:Bot" });
    db.close();
  });
});
