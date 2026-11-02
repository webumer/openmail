import { runInNewContext } from "node:vm";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { migrate, openDatabase } from "../src/db/index.js";
import { users, apiKeys } from "../src/services/index.js";
import { issuePasswordReset, completePasswordReset, prunePasswordResets, RESET_TTL_MS } from "../src/services/password-resets.js";
import { createSystemMailer, type SystemMailer } from "../src/services/system-mailer.js";
import { createPasswordResetHandler } from "../src/web/password-reset.js";
import { createSession } from "../src/web/session.js";
import { httpFake } from "./helpers/http-fake.js";
import type { Metric } from "../src/services/metrics.js";

const PASSWORD = "original-password";
const NEW_PASSWORD = "replacement-password";
let db: Database;
let userId: string;
beforeEach(async () => {
  db = openDatabase(":memory:"); migrate(db);
  userId = (await users.create(db, Buffer.alloc(32, 1), { email: "ada@example.com", password: PASSWORD })).id;
});
afterEach(() => db.close());

describe("password reset tokens", () => {
  it("stores only a SHA-256 hash, retires prior codes and prunes expiry", async () => {
    const now = Date.now();
    const token = issuePasswordReset(db, userId, now);
    expect(Buffer.from(token, "base64url")).toHaveLength(32);
    const row = db.prepare("SELECT * FROM password_resets").get() as { token_hash: string; expires_at: string };
    expect(row.token_hash).toBe(createHash("sha256").update(token).digest("hex"));
    expect(JSON.stringify(row)).not.toContain(token);
    expect(Date.parse(row.expires_at) - now).toBe(RESET_TTL_MS);
    const next = issuePasswordReset(db, userId, now + 1);
    await expect(completePasswordReset(db, token, NEW_PASSWORD)).rejects.toMatchObject({ code: "invalid_reset" });
    await expect(completePasswordReset(db, next, NEW_PASSWORD, () => now + 1 + RESET_TTL_MS)).rejects.toMatchObject({ code: "invalid_reset" });
    prunePasswordResets(db, now + 1 + RESET_TTL_MS);
    expect(db.prepare("SELECT * FROM password_resets").all()).toEqual([]);
  });

  it("changes the password atomically once and deletes sessions while preserving keys and OAuth grants", async () => {
    const key = apiKeys.create(db, { userId, name: "assistant" });
    createSession(db, userId); createSession(db, userId);
    db.prepare(`INSERT INTO oauth_grants (id, user_id, client_id, client_kind, client_name, redirect_host, scope, resource, created_at)
      VALUES ('grant', ?, 'client', 'dcr', 'App', 'example.com', 'mail.read', 'https://example.com/mcp', ?)`)
      .run(userId, new Date().toISOString());
    const token = issuePasswordReset(db, userId);
    const results = await Promise.allSettled([completePasswordReset(db, token, NEW_PASSWORD), completePasswordReset(db, token, NEW_PASSWORD)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(db.prepare("SELECT * FROM sessions").all()).toEqual([]);
    expect(await users.verifyPassword(db, { email: "ada@example.com", password: NEW_PASSWORD })).not.toBeNull();
    expect(await users.verifyPassword(db, { email: "ada@example.com", password: PASSWORD })).toBeNull();
    expect(apiKeys.resolve(db, key.token)).not.toBeNull();
    expect(db.prepare("SELECT revoked_at FROM oauth_grants").get()).toEqual({ revoked_at: null });
    await expect(completePasswordReset(db, token, NEW_PASSWORD)).rejects.toMatchObject({ code: "invalid_reset" });
  });

  it("rejects bad passwords and tokens without consuming a valid token; admin changes retire tokens", async () => {
    const token = issuePasswordReset(db, userId);
    await expect(completePasswordReset(db, token, "short")).rejects.toMatchObject({ code: "invalid_argument" });
    await expect(completePasswordReset(db, "invalid", NEW_PASSWORD)).rejects.toMatchObject({ code: "invalid_reset" });
    expect(await users.verifyPassword(db, { email: "ada@example.com", password: PASSWORD })).not.toBeNull();
    await users.setPassword(db, { email: "ada@example.com", password: NEW_PASSWORD });
    await expect(completePasswordReset(db, token, NEW_PASSWORD)).rejects.toMatchObject({ code: "invalid_reset" });
    db.prepare("DELETE FROM users WHERE id = ?").run(userId);
    expect(db.prepare("SELECT * FROM password_resets").all()).toEqual([]);
  });
});

describe("password reset forms", () => {
  function harness(configured = true, pendingSend = false) {
    const sent: { to: string; link: string; code: string }[] = [];
    const metrics: Metric[] = [];
    const mailer: SystemMailer = { configured, async sendPasswordReset(to, link, code) {
      sent.push({ to, link, code });
      if (pendingSend) await new Promise<void>(() => {});
    } };
    const handler = createPasswordResetHandler({ db, systemMailer: mailer, publicUrl: "https://mail.example.com/", secureCookies: false,
      trustProxy: false, bodyLimit: 1024 * 1024, metrics: { record: (metric) => metrics.push(metric) } });
    const submit = async (path: string, fields: Record<string, string>, ip?: string) => {
      const call = httpFake(path, { method: "POST", cookie: "om_csrf=csrf", fields: { _csrf: "csrf", ...fields }, ip });
      await handler(call.req, call.res);
      return call.state;
    };
    return { sent, handler, submit, metrics };
  }

  it("responds identically for known and unknown addresses and responds before mail is delivered", async () => {
    const t = harness(true, true);
    const known = await t.submit("/forgot", { email: "ada@example.com" });
    const unknown = await t.submit("/forgot", { email: "unknown@example.com" });
    expect(known.status).toBe(200);
    expect(known.body).toBe(unknown.body);
    expect(t.sent).toHaveLength(0);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(t.sent).toHaveLength(1);
    expect(t.sent[0]?.link).toBe(`https://mail.example.com/reset#token=${t.sent[0]?.code}`);
    expect(known.body).not.toContain(t.sent[0]!.code);
  });

  it("limits per email across IPs and per IP across emails with the same neutral response", async () => {
    const t = harness();
    const first = await t.submit("/forgot", { email: "ada@example.com" }, "ip-1");
    for (let i = 2; i <= 4; i++) expect((await t.submit("/forgot", { email: "ADA@example.com" }, `ip-${i}`)).body).toBe(first.body);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(t.sent).toHaveLength(3);
    for (let i = 0; i < 6; i++) await t.submit("/forgot", { email: `unknown${i}@example.com` }, "one-ip");
    expect(t.metrics.filter((m) => m.outcome === "rate_limited")).toHaveLength(2);
    await new Promise<void>((resolve) => setImmediate(resolve));
  });

  it("does not create tokens when system email is unavailable; requires CSRF", async () => {
    const t = harness(false);
    const get = httpFake("/forgot"); await t.handler(get.req, get.res);
    expect(get.state.body).toContain("support@openmail.tools");
    expect(get.state.headers.get("set-cookie")).toContain("om_csrf=");
    const post = await t.submit("/forgot", { email: "ada@example.com" });
    expect(post.body).toContain("isn&#39;t switched on");
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(t.sent).toHaveLength(0);
    expect(db.prepare("SELECT * FROM password_resets").all()).toEqual([]);
    expect((await t.submit("/forgot", { _csrf: "wrong", email: "ada@example.com" })).status).toBe(403);
  });

  it("does not consume an email's reset quota when the request IP is blocked", async () => {
    const t = harness();
    for (let i = 0; i < 5; i++) await t.submit("/forgot", { email: `unknown${i}@example.com` }, "blocked-ip");
    for (let i = 0; i < 3; i++) await t.submit("/forgot", { email: "ada@example.com" }, "blocked-ip");
    for (let i = 0; i < 4; i++) await t.submit("/forgot", { email: "ada@example.com" }, `fresh-ip-${i}`);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(t.sent).toHaveLength(3);
    expect(t.metrics.filter((metric) => metric.outcome === "rate_limited")).toHaveLength(4);
  });

  it("moves the fragment code into a hidden POST field and clears browser history", () => {
    const script = readFileSync(new URL("../src/web/static/app.js", import.meta.url), "utf8");
    const token = "a".repeat(43);
    for (const code of [token, "invalid-code"]) {
      const input = { value: "", type: "text" };
      const label = { hidden: false };
      const help = { hidden: false };
      const fields: Record<string, unknown> = { "reset-token": input, "reset-code-label": label, "reset-code-help": help };
      const navigations: unknown[][] = [];
      runInNewContext(script, {
        document: { getElementById: (id: string) => fields[id] ?? null }, URLSearchParams,
        window: { location: { hash: `#token=${code}`, pathname: "/reset" } },
        history: { replaceState: (...args: unknown[]) => navigations.push(args) },
      });
      expect(navigations).toEqual([[null, "", "/reset"]]);
      expect(input.value).toBe(code === token ? token : "");
      expect(input.type).toBe(code === token ? "hidden" : "text");
      expect(label.hidden).toBe(code === token);
      expect(help.hidden).toBe(code === token);
    }
  });

  it("accepts a pasted code, validates confirmation and password rules, and limits reset POSTs", async () => {
    const t = harness();
    const token = issuePasswordReset(db, userId);
    const get = httpFake("/reset"); await t.handler(get.req, get.res);
    expect(get.state.body).toContain('id="reset-token"');
    expect(get.state.body).toContain('src="/static/app.js"');
    expect((await t.submit("/reset", { token, password: NEW_PASSWORD, confirm: "wrong" })).body).toContain("Passwords do not match");
    expect((await t.submit("/reset", { token, password: "short", confirm: "short" })).status).toBe(400);
    const changed = await t.submit("/reset", { token, password: NEW_PASSWORD, confirm: NEW_PASSWORD });
    expect(changed.status).toBe(200);
    expect(changed.body).toContain("Password changed. Sign in again. All web sessions were signed out. Your API keys and connected apps still work — review them on the dashboard.");
    expect(changed.body).toContain('href="/dashboard"');
    expect(changed.body).toContain('href="/login"');
    for (let i = 0; i < 7; i++) expect((await t.submit("/reset", { token, password: NEW_PASSWORD, confirm: NEW_PASSWORD })).status).toBe(400);
    expect((await t.submit("/reset", { token, password: NEW_PASSWORD, confirm: NEW_PASSWORD })).status).toBe(429);
    const js = readFileSync(new URL("../src/web/static/app.js", import.meta.url), "utf8");
    expect(js).toContain('history.replaceState(null, "", window.location.pathname)');
  });
});

describe("system mail transport", () => {
  it.each(["1", "0"])("uses verified TLS and bounded timeouts for secure=%s", async (secure) => {
    let options: unknown;
    let message: unknown;
    let closed = false;
    const mailer = createSystemMailer({ OPENMAIL_SYSTEM_SMTP_HOST: "smtp.example.com", OPENMAIL_SYSTEM_SMTP_USER: "system",
      OPENMAIL_SYSTEM_SMTP_PASS: "fake-system-password", OPENMAIL_SYSTEM_SMTP_FROM: "OpenMail <reset@example.com>", OPENMAIL_SYSTEM_SMTP_SECURE: secure },
    (received) => { options = received; return { sendMail: async (mail) => { message = mail; }, close() { closed = true; } }; });
    await mailer.sendPasswordReset("ada@example.com", "https://mail.example.com/reset#token=fake-code", "fake-code");
    expect(options).toMatchObject({ port: 465, secure: secure === "1", requireTLS: secure === "0", tls: { rejectUnauthorized: true }, connectionTimeout: 15_000, greetingTimeout: 15_000, logger: false, debug: false });
    expect(message).toMatchObject({ text: expect.stringContaining("expire in 30 minutes") });
    expect(closed).toBe(true);
    expect(createSystemMailer({}).configured).toBe(false);
  });

  it("sanitizes delivery errors and closes the transport", async () => {
    let closed = false;
    const mailer = createSystemMailer({ OPENMAIL_SYSTEM_SMTP_HOST: "smtp.example.com", OPENMAIL_SYSTEM_SMTP_USER: "system",
      OPENMAIL_SYSTEM_SMTP_PASS: "fake-password", OPENMAIL_SYSTEM_SMTP_FROM: "reset@example.com" }, () => ({
      async sendMail() { throw new Error("fake-password ada@example.com smtp.example.com"); }, close() { closed = true; },
    }));
    await expect(mailer.sendPasswordReset("ada@example.com", "link", "code")).rejects.toThrow("Password reset email could not be delivered");
    expect(closed).toBe(true);
  });
});
