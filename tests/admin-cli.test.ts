import { afterEach, describe, expect, it, vi } from "vitest";
import { runAdmin } from "../src/cli/admin.js";
import { generateTestMasterKey, loadMasterKey } from "../src/crypto/index.js";
import { migrate, openDatabase } from "../src/db/index.js";
import type { ImapGateway } from "../src/mail/imap-gateway.js";
import { apiKeys, users, mailAccounts } from "../src/services/index.js";
import { MAX_MAIL_ACCOUNTS_PER_USER } from "../src/services/mail-accounts.js";
import { SqliteCredentialStore } from "../src/store/index.js";
import type { AccountCredentials } from "../src/store/types.js";

const LOGIN_SECRET = "operator-chosen-login-pass";
const MAILBOX_SECRET = "mailbox-secret-from-env";
const LEGACY_KEY = "a".repeat(16) + "0123456789abcdef0123456789abcdef0123456789abcdef";
const databases: ReturnType<typeof openDatabase>[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const db of databases.splice(0)) db.close(); });

function setup() {
  const db = openDatabase(":memory:");
  databases.push(db);
  migrate(db);
  const masterKey = loadMasterKey(generateTestMasterKey());
  const probes: AccountCredentials[] = [];
  const imap: ImapGateway = {
    async withClient(account, fn) {
      probes.push(account);
      if (account.password !== MAILBOX_SECRET) throw new Error("auth failed");
      return fn({} as never);
    },
    withMailbox() {
      return Promise.reject(new Error("not used"));
    },
    appendMessage() {
      return Promise.reject(new Error("not used"));
    },
  };
  const smtp = { verify: async () => undefined, send: async () => { throw new Error("must not send"); } };
  const lines: string[] = [];
  const io = (secret: string, env: Record<string, string | undefined> = {}) => ({
    readSecret: async () => secret,
    env,
    out: (line: string) => lines.push(line),
  });
  return { db, masterKey, imap, smtp, probes, lines, io };
}

describe("admin CLI", () => {
  it("restores the exact main list-users and list-accounts columns", async () => {
    const t = setup();
    const user = await users.create(t.db, t.masterKey, { email: "operator@example.com", password: LOGIN_SECRET });
    const mailbox = mailAccounts.add(t.db, t.masterKey, { userId: user.id, name: "Work inbox", email: "mailbox@example.com", preset: "migadu", password: MAILBOX_SECRET });
    apiKeys.create(t.db, { userId: user.id, name: "assistant" });
    await runAdmin(["list-users"], t, t.io(""));
    expect(t.lines.splice(0)).toEqual([`operator@example.com\t${user.id}\taccounts=1\tactive_keys=1`, "users=1"]);
    await runAdmin(["list-accounts", "--user", "operator@example.com"], t, t.io(""));
    expect(t.lines.splice(0)).toEqual([`Work inbox\t${mailbox.id}\tmigadu\timap.migadu.com\tsending=off`, "accounts=1"]);
  });

  it("probes only IMAP when adding even if SMTP would fail, and still checks SMTP on enable-sending", async () => {
    const t = setup();
    await users.create(t.db, t.masterKey, { email: "operator@example.com", password: LOGIN_SECRET });
    const verify = vi.fn(async () => { throw Object.assign(new Error("SMTP unavailable"), { code: "ECONNREFUSED" }); });
    const deps = { ...t, smtp: { ...t.smtp, verify } };
    await runAdmin(["add-account", "--user", "operator@example.com", "--name", "work", "--email", "mailbox@example.com", "--preset", "migadu"], deps, t.io(MAILBOX_SECRET));
    expect(t.probes).toHaveLength(1);
    expect(verify).not.toHaveBeenCalled();
    expect(t.lines).toContain("imap login ok");
    await expect(runAdmin(["enable-sending", "--user", "operator@example.com", "--name", "work"], deps, t.io("")))
      .rejects.toMatchObject({ category: "connection_refused" });
    expect(verify).toHaveBeenCalledOnce();
    expect(t.db.prepare("SELECT send_enabled FROM mail_accounts").get()).toEqual({ send_enabled: 0 });
  });

  it.each(["conflict", "limit", "database"])("does not record a connection failure for an add-account %s error", async (failure) => {
    const t = setup();
    const user = await users.create(t.db, t.masterKey, { email: "operator@example.com", password: LOGIN_SECRET });
    const input = { userId: user.id, name: "work", email: "mailbox@example.com", preset: "migadu", password: MAILBOX_SECRET };
    if (failure === "conflict") mailAccounts.add(t.db, t.masterKey, input);
    if (failure === "limit") {
      for (let i = 0; i < MAX_MAIL_ACCOUNTS_PER_USER; i++) mailAccounts.add(t.db, t.masterKey, { ...input, name: `mailbox-${i}` });
    }
    if (failure === "database") vi.spyOn(mailAccounts, "add").mockImplementationOnce(() => { throw new Error("database failure"); });
    await expect(runAdmin(["add-account", "--user", "operator@example.com", "--name", "work", "--email", "mailbox@example.com", "--preset", "migadu"], t, t.io(MAILBOX_SECRET)))
      .rejects.toThrow();
    expect(t.probes).toHaveLength(1);
    expect(t.db.prepare("SELECT * FROM metric_counts WHERE kind = 'mailbox_save'").all()).toEqual([]);
  });
  it("creates a user, imports a legacy key, and adds a probed mailbox without printing secrets", async () => {
    const t = setup();
    const deps = { db: t.db, masterKey: t.masterKey, imap: t.imap, smtp: t.smtp };
    await runAdmin(["create-user", "--email", "Owner@Example.com"], deps, t.io(LOGIN_SECRET));
    expect(await users.verifyPassword(t.db, { email: "owner@example.com", password: LOGIN_SECRET })).not.toBeNull();

    await runAdmin(["import-key", "--user", "owner@example.com", "--name", "grok"], deps, t.io(LEGACY_KEY));
    const resolved = apiKeys.resolve(t.db, LEGACY_KEY);
    expect(resolved).not.toBeNull();
    await expect(
      runAdmin(["import-key", "--user", "owner@example.com", "--name", "again"], deps, t.io(LEGACY_KEY)),
    ).rejects.toThrow(/already registered/);
    await expect(runAdmin(["import-key", "--user", "owner@example.com", "--name", "short"], deps, t.io("short"))).rejects.toThrow();

    await expect(
      runAdmin(
        ["add-account", "--user", "owner@example.com", "--name", "work", "--email", "me@work.example", "--preset", "migadu", "--password-env", "PW"],
        deps,
        t.io("", { PW: "wrong" }),
      ),
    ).rejects.toThrow(/IMAP login failed/);
    await runAdmin(
      ["add-account", "--user", "owner@example.com", "--name", "work", "--email", "me@work.example", "--preset", "migadu", "--password-env", "PW"],
      deps,
      t.io("", { PW: MAILBOX_SECRET }),
    );
    expect(t.probes.at(-1)?.imap.host).toBe("imap.migadu.com");

    const store = new SqliteCredentialStore(t.db, t.masterKey);
    const listed = await store.listAccounts(resolved!.userId);
    expect(listed.map((a) => a.label)).toEqual(["work"]);
    const byName = await store.getAccount(resolved!.userId, "work");
    expect(byName?.password).toBe(MAILBOX_SECRET);
    expect((await store.getAccount(resolved!.userId, listed[0]!.id))?.label).toBe("work");

    await runAdmin(["list-users"], deps, t.io(""));
    const output = t.lines.join("\n");
    for (const secret of [LOGIN_SECRET, MAILBOX_SECRET, LEGACY_KEY]) expect(output).not.toContain(secret);
    expect(output).toContain("accounts=1");
  });

  it("does not let another user reach an account by name", async () => {
    const t = setup();
    const deps = { db: t.db, masterKey: t.masterKey, imap: t.imap, smtp: t.smtp };
    await runAdmin(["create-user", "--email", "a@example.com"], deps, t.io(LOGIN_SECRET));
    await runAdmin(["create-user", "--email", "b@example.com"], deps, t.io(LOGIN_SECRET));
    await runAdmin(
      ["add-account", "--user", "a@example.com", "--name", "shared-name", "--email", "a@work.example", "--preset", "fastmail", "--skip-probe"],
      deps,
      t.io(MAILBOX_SECRET),
    );
    const b = t.db.prepare("SELECT id FROM users WHERE email = ?").get("b@example.com") as { id: string };
    const store = new SqliteCredentialStore(t.db, t.masterKey);
    expect(await store.getAccount(b.id, "shared-name")).toBeNull();
  });

  it("adds a custom plain-IMAP host only when it is on the operator allowlist", async () => {
    const t = setup();
    const deps = { db: t.db, masterKey: t.masterKey, imap: t.imap, smtp: t.smtp };
    await runAdmin(["create-user", "--email", "reviewer@example.com"], deps, t.io(LOGIN_SECRET));
    const args = ["add-account", "--user", "reviewer@example.com", "--name", "Demo mailbox", "--email", "demo@demo.example", "--preset", "custom", "--imap-host", "demo-mail", "--imap-port", "3143", "--plain", "--username", "demo"];
    await expect(runAdmin(args, deps, t.io(MAILBOX_SECRET, {}))).rejects.toThrow(/OPENMAIL_INSECURE_IMAP_HOSTS/);
    expect(t.db.prepare("SELECT outcome, count FROM metric_counts WHERE kind = 'mailbox_save'").all())
      .toEqual([{ outcome: "imap:host_not_allowed", count: 1 }]);
    await expect(
      runAdmin(["add-account", "--user", "reviewer@example.com", "--name", "x", "--email", "x@example.com", "--preset", "custom", "--imap-host", "imap.example.com", "--imap-port", "993"], deps, t.io(MAILBOX_SECRET, { OPENMAIL_INSECURE_IMAP_HOSTS: "demo-mail" })),
    ).rejects.toThrow(/OPENMAIL_INSECURE_IMAP_HOSTS/);
    await runAdmin(args, deps, t.io(MAILBOX_SECRET, { OPENMAIL_INSECURE_IMAP_HOSTS: "demo-mail" }));
    expect(t.probes.at(-1)?.imap).toEqual({ host: "demo-mail", port: 3143, secure: false });
    expect(t.probes.at(-1)?.insecureImapHosts).toEqual(["demo-mail"]);
  });

  it("sets a new login password, signs out sessions, keeps API keys, never prints it", async () => {
    const t = setup();
    const deps = { db: t.db, masterKey: t.masterKey, imap: t.imap, smtp: t.smtp };
    const NEW_SECRET = "a-brand-new-login-pass-123";
    await runAdmin(["create-user", "--email", "owner@example.com"], deps, t.io(LOGIN_SECRET));
    await runAdmin(["import-key", "--user", "owner@example.com", "--name", "grok"], deps, t.io(LEGACY_KEY));
    const user = t.db.prepare("SELECT id FROM users WHERE email = ?").get("owner@example.com") as { id: string };
    const now = new Date();
    t.db
      .prepare("INSERT INTO sessions (id, user_id, csrf_secret, created_at, expires_at) VALUES (?, ?, ?, ?, ?)")
      .run("s1", user.id, "c", now.toISOString(), new Date(now.getTime() + 3_600_000).toISOString());

    await runAdmin(["set-password", "--email", "Owner@Example.com"], deps, t.io(NEW_SECRET));
    expect(await users.verifyPassword(t.db, { email: "owner@example.com", password: NEW_SECRET })).not.toBeNull();
    expect(await users.verifyPassword(t.db, { email: "owner@example.com", password: LOGIN_SECRET })).toBeNull();
    expect((t.db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?").get(user.id) as { n: number }).n).toBe(0);
    expect(apiKeys.resolve(t.db, LEGACY_KEY)).not.toBeNull();
    expect(t.lines.join("\n")).not.toContain(NEW_SECRET);
    expect(t.lines.join("\n")).toContain("sessions signed out=1");

    await expect(runAdmin(["set-password", "--email", "nobody@example.com"], deps, t.io(NEW_SECRET))).rejects.toThrow(/not found/);
    await expect(runAdmin(["set-password", "--email", "owner@example.com"], deps, t.io("short"))).rejects.toThrow();
    expect(await users.verifyPassword(t.db, { email: "owner@example.com", password: NEW_SECRET })).not.toBeNull();
  });
});
