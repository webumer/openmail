import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openDatabase, migrate } from "../src/db/index.js";
import { users, mailAccounts } from "../src/services/index.js";
import { MAX_MAIL_ACCOUNTS_PER_USER } from "../src/services/mail-accounts.js";
import type { Metric } from "../src/services/metrics.js";
import { createWebHandler } from "../src/web/router.js";
import { createSession } from "../src/web/session.js";
import type { ImapGateway } from "../src/mail/imap-gateway.js";
import { httpFake } from "./helpers/http-fake.js";
import { SECRET } from "./fixtures.js";

// No DNS or mail servers are contacted by setup tests.
vi.mock("../src/mail/address-guard.js", async (original) => ({
  ...await original<typeof import("../src/mail/address-guard.js")>(),
  defaultResolver: async (host: string) => {
    if (host.startsWith("missing")) throw Object.assign(new Error("getaddrinfo internal.host"), { code: "ENOTFOUND" });
    if (host.startsWith("empty")) return [];
    if (host.startsWith("private")) return ["172.18.0.3"];
    return ["93.184.216.34"];
  },
}));

const masterKey = Buffer.alloc(32, 2);
let db: ReturnType<typeof openDatabase>;
let userId: string;
beforeEach(async () => {
  db = openDatabase(":memory:"); migrate(db);
  userId = (await users.create(db, masterKey, { email: "ada@example.com", password: "test-login-password" })).id;
});
afterEach(() => { vi.restoreAllMocks(); db.close(); });

function harness() {
  const metrics: Metric[] = [];
  const session = createSession(db, userId);
  const withClient = vi.fn(async (_account: unknown, fn: (session: never) => Promise<unknown>) => fn({} as never));
  const verify = vi.fn(async () => {});
  const send = vi.fn(async (): Promise<never> => { throw new Error("must not send mail"); });
  const handler = createWebHandler({ db, masterKey, imap: { withClient } as unknown as ImapGateway,
    smtp: { verify, send }, secureCookies: false, trustProxy: false, allowInsecureLocalhost: false,
    bodyLimit: 1024 * 1024, metrics: { record: (metric) => metrics.push(metric) } });
  const submit = async (path: string, fields: Record<string, string> = {}) => {
    const call = httpFake(path, { method: "POST", cookie: `om_session=${session.token}`, fields: { _csrf: session.csrfSecret, ...fields } });
    await handler(call.req, call.res);
    expect(send).not.toHaveBeenCalled();
    expect(call.state.body).not.toContain(SECRET);
    return call.state;
  };
  return { metrics, submit, withClient, verify };
}

const presetFields = { name: "work", email: "mailbox@example.com", password: SECRET, preset: "gmail" };
const customFields = { ...presetFields, preset: "custom", imap_host: "mail.example.com", imap_port: "993", imap_secure: "on",
  smtp_host: "mail.example.com", smtp_port: "465", smtp_secure: "on" };

describe("mailbox setup requirements", () => {
  it("requires only IMAP on Save when no SMTP fields are present", async () => {
    const t = harness();
    t.verify.mockRejectedValue(Object.assign(new Error("SMTP unavailable"), { code: "ECONNREFUSED" }));
    const saved = await t.submit("/accounts", presetFields);
    expect(saved.status).toBe(303);
    expect(t.withClient).toHaveBeenCalledOnce();
    expect(t.verify).not.toHaveBeenCalled();
    expect(mailAccounts.list(db, userId)).toMatchObject([{ name: "work", sendEnabled: false }]);
    expect(t.metrics).toEqual([{ kind: "mailbox_save", name: "gmail", outcome: "ok" }]);
  });

  it.each(["smtp_host", "smtp_username"])("saves with an SMTP warning when %s is supplied and SMTP fails", async (field) => {
    const t = harness();
    t.verify.mockRejectedValue(Object.assign(new Error(`host.example.com ${SECRET}`), { code: "ETIMEDOUT" }));
    const fields: Record<string, string> = field === "smtp_host" ? { smtp_host: "smtp.gmail.com" } : { smtp_username: "separate@example.com", smtp_password: "fake-smtp-password" };
    const saved = await t.submit("/accounts", { ...presetFields, ...fields });
    expect(saved.status).toBe(200);
    expect(saved.body).toContain("Mailbox saved. IMAP: Reading works. SMTP:");
    expect(saved.body).toContain('class="notice warn"');
    expect(saved.body).toContain("Sending would not work");
    expect(saved.body).not.toContain("host.example.com");
    expect(saved.body).not.toContain("fake-smtp-password");
    expect(t.verify).toHaveBeenCalledOnce();
    expect(mailAccounts.list(db, userId)).toMatchObject([{ name: "work", sendEnabled: false }]);
    expect(t.metrics).toEqual([{ kind: "mailbox_save", name: "gmail", outcome: "smtp:timeout" }]);
  });

  it("reports IMAP reading success separately from an SMTP failure on Test connection and checks again on enable-sending", async () => {
    const t = harness();
    t.verify.mockRejectedValue(Object.assign(new Error("SMTP failure"), { code: "EAUTH" }));
    const tested = await t.submit("/accounts/test", presetFields);
    expect(tested.status).toBe(400);
    expect(tested.body).toContain("IMAP: Signed in. Reading works. SMTP: Sign-in failed");
    expect(tested.body).toContain("Sending would not work");
    expect(mailAccounts.list(db, userId)).toEqual([]);
    await t.submit("/accounts", presetFields);
    const mailbox = mailAccounts.list(db, userId)[0]!;
    const enabled = await t.submit(`/accounts/${mailbox.id}/sending`, { enabled: "1" });
    expect(enabled.status).toBe(400);
    expect(mailAccounts.list(db, userId)[0]?.sendEnabled).toBe(false);
    expect(t.verify).toHaveBeenCalledTimes(2);
    expect(t.metrics.map((m) => m.outcome)).toEqual(["smtp:auth_failed", "ok", "smtp:auth_failed"]);
  });

  it("requires IMAP for both Save and Test connection and skips SMTP after IMAP failure", async () => {
    const t = harness();
    t.withClient.mockRejectedValue(Object.assign(new Error("IMAP failure"), { authenticationFailed: true }));
    for (const path of ["/accounts", "/accounts/test"]) {
      expect((await t.submit(path, customFields)).status).toBe(400);
    }
    expect(mailAccounts.list(db, userId)).toEqual([]);
    expect(t.verify).not.toHaveBeenCalled();
    expect(t.metrics.map((m) => m.outcome)).toEqual(["imap:auth_failed", "imap:auth_failed"]);
  });

  it.each(["/accounts", "/accounts/test"])("uses identical DNS refusal messages and metrics at %s", async (path) => {
    const t = harness();
    const bodies: string[] = [];
    for (const host of ["missing.example.com", "empty.example.com", "private.example.com"]) {
      const refused = await t.submit(path, { ...customFields, imap_host: host });
      expect(refused.status).toBe(400);
      // The form retains the entered host; compare only the user-facing error block.
      bodies.push(refused.body.match(/<div class="errors"[^]*?<\/div>/)?.[0] ?? "");
    }
    expect(bodies[0]).toContain("Use a public mail server address");
    expect(new Set(bodies).size).toBe(1);
    expect(t.metrics.map((m) => m.outcome)).toEqual(["imap:host_not_allowed", "imap:host_not_allowed", "imap:host_not_allowed"]);
    expect(t.withClient).not.toHaveBeenCalled();
    expect(t.verify).not.toHaveBeenCalled();
  });

  it("saves IMAP with an SMTP warning when the SMTP address guard refuses the host", async () => {
    const t = harness();
    const saved = await t.submit("/accounts", { ...customFields, smtp_host: "private.example.com" });
    expect(saved.status).toBe(200);
    expect(saved.body).toContain("Mailbox saved. IMAP: Reading works.");
    expect(saved.body).toContain("SMTP:");
    expect(saved.body).toContain("Use a public mail server address");
    expect(t.withClient).toHaveBeenCalledOnce();
    expect(t.verify).not.toHaveBeenCalled();
    expect(mailAccounts.list(db, userId)).toHaveLength(1);
    expect(t.metrics.map((m) => m.outcome)).toEqual(["smtp:host_not_allowed"]);
  });

  it.each(["conflict", "limit", "database"])("does not misreport a Save %s failure as IMAP", async (failure) => {
    const t = harness();
    const input = { userId, name: "work", email: "mailbox@example.com", preset: "gmail", password: SECRET };
    if (failure === "conflict") mailAccounts.add(db, masterKey, input);
    if (failure === "limit") {
      for (let i = 0; i < MAX_MAIL_ACCOUNTS_PER_USER; i++) mailAccounts.add(db, masterKey, { ...input, name: `mailbox-${i}` });
    }
    if (failure === "database") vi.spyOn(mailAccounts, "add").mockImplementationOnce(() => { throw new Error("database failure"); });
    const response = await t.submit("/accounts", presetFields);
    expect(response.status).toBe(failure === "database" ? 500 : 400);
    expect(t.withClient).toHaveBeenCalledOnce();
    expect(t.metrics).toEqual([]);
  });
});
