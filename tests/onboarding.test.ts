import { createHash } from "node:crypto";
import { createOAuthHandler } from "../src/oauth/http.js";
import { deriveOAuthConfig } from "../src/oauth/config.js";
import { registerClient } from "../src/oauth/clients.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { createMailMcpServer } from "../src/tools/register.js";
import { createMemorySendRecorder } from "../src/services/send-log.js";
import type { Metric } from "../src/services/metrics.js";
import { setupRequired } from "../src/mail/setup.js";
import { createOpenMailServer } from "../src/server/http.js";
import { rateLimitFromEnv, imapTimeoutFromEnv } from "../src/config/runtime.js";
import { SlidingWindowRateLimit } from "../src/server/rate-limit.js";
import { httpFake } from "./helpers/http-fake.js";
import { createWebHandler } from "../src/web/router.js";
import { createSession } from "../src/web/session.js";
import { openDatabase, migrate } from "../src/db/index.js";
import { users } from "../src/services/index.js";
import { account } from "./fixtures.js";
import type { AccountSummary } from "../src/store/types.js";
import type { ImapGateway } from "../src/mail/imap-gateway.js";

const forbiddenImap: ImapGateway = {
  async withClient() { throw new Error("must not contact IMAP"); },
  async withMailbox() { throw new Error("must not contact IMAP"); },
  async appendMessage() { throw new Error("must not contact IMAP"); },
};
const smtp = { async verify() {}, async send(): Promise<never> { throw new Error("must not send mail"); } };

describe("onboarding and MCP metrics", () => {
  it("returns successful setup guidance for all seven tools, preserving not_found for users with mailboxes", async () => {
    const metrics: Metric[] = [];
    let accounts: AccountSummary[] = [];
    const server = createMailMcpServer({ store: { listAccounts: async () => accounts, getAccount: async () => null },
      imap: forbiddenImap, smtp, sends: createMemorySendRecorder(), userId: "user", canSend: true, via: "test",
      publicUrl: "https://mail.example.com/", metrics: { record: (m) => metrics.push(m) } });
    const client = new Client({ name: "test", version: "1" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport); await client.connect(clientTransport);
    try {
      for (const [name, args, data] of [
        ["list_accounts", {}, []], ["list_folders", { account: "unknown" }, []],
        ["search_messages", { account: "unknown" }, { messages: [], next_cursor: null }],
        ["read_message", { account: "unknown", folder: "INBOX", uid: 1 }, null],
        ["read_thread", { account: "unknown", folder: "INBOX", uid: 1 }, null],
        ["get_attachment", { account: "unknown", folder: "INBOX", uid: 1, index: 0 }, null],
        ["send_message", { account: "unknown", to: ["fake@example.com"], body: "hello", user_confirmed: true }, { sent: false }],
      ] as const) {
        const result = await client.callTool({ name, arguments: args });
        expect(result.isError).toBe(false);
        expect(result.structuredContent).toMatchObject({ ok: true, data, setup_required: true, dashboard_url: "https://mail.example.com/dashboard" });
        expect(JSON.stringify(result.content)).toContain("No mailbox is connected");
        if (name === "send_message") expect(JSON.stringify(result.content)).toContain("Nothing was sent");
      }
      expect(metrics).toHaveLength(7);
      expect(metrics.every((m) => m.kind === "tool_call" && m.outcome === "setup_required")).toBe(true);
      accounts = [{ id: "work", label: "work", email: "fake@example.com", preset: "migadu", imapHost: "imap.migadu.com", sendEnabled: false }];
      const result = await client.callTool({ name: "list_folders", arguments: { account: "unknown" } });
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({ error: { code: "not_found" } });
      expect(metrics.at(-1)).toMatchObject({ outcome: "not_found" });
    } finally { await client.close(); await server.close(); }
    expect(setupRequired("list_accounts").message).toContain("the OpenMail dashboard");
    expect(setupRequired("list_accounts").dashboard_url).toBeUndefined();
  });

  it("defaults to a burst of 90 per key, counts MCP rejections, and keeps the window sliding", async () => {
    const metrics: Metric[] = [];
    const server = createOpenMailServer({ store: {} as never, imap: forbiddenImap, smtp, sends: createMemorySendRecorder(),
      authenticate: () => ({ userId: "user", keyId: "key", canSend: false, via: "test" }), metrics: { record: (m) => metrics.push(m) } });
    for (let i = 0; i < 91; i++) {
      const call = httpFake("/mcp"); server.emit("request", call.req, call.res); await call.finished;
      expect(call.state.status).toBe(i < 90 ? 405 : 429);
    }
    expect(metrics).toEqual([{ kind: "mcp_rate_limited", name: "mcp", outcome: "429" }]);
    const limiter = new SlidingWindowRateLimit(90, 60_000);
    for (let i = 0; i < 90; i++) expect(limiter.allow("key", 1_000)).toBe(true);
    expect(limiter.allow("key", 60_999)).toBe(false);
    expect(limiter.allow("key", 61_000)).toBe(true);
  });

  it("validates runtime limit settings without echoing values", () => {
    expect(rateLimitFromEnv({})).toBe(90);
    expect(imapTimeoutFromEnv({})).toBe(25_000);
    expect(rateLimitFromEnv({ OPENMAIL_RATE_LIMIT_PER_MINUTE: "10000" })).toBe(10_000);
    expect(imapTimeoutFromEnv({ OPENMAIL_IMAP_OP_TIMEOUT_MS: "5000" })).toBe(5_000);
    for (const value of ["0", "10001", "1.5", "private-value"]) expect(() => rateLimitFromEnv({ OPENMAIL_RATE_LIMIT_PER_MINUTE: value })).toThrow(/must be an integer/);
    for (const value of ["4999", "120001", "", "25000ms"]) expect(() => imapTimeoutFromEnv({ OPENMAIL_IMAP_OP_TIMEOUT_MS: value })).toThrow(/must be an integer/);
  });

  it("keeps OAuth consent and its return navigation working for an account without mailboxes", async () => {
    const db = openDatabase(":memory:"); migrate(db);
    try {
      const user = await users.create(db, Buffer.alloc(32, 2), { email: "new@example.com", password: "test-login-password" });
      const session = createSession(db, user.id);
      const client = registerClient(db, { client_name: "Test", redirect_uris: ["https://assistant.example.com/callback"] }).client;
      const config = deriveOAuthConfig("https://mail.example.com")!;
      const handler = createOAuthHandler({ db, config, fetcher: async () => { throw new Error("no external requests"); }, trustProxy: false });
      const verifier = "a".repeat(43);
      const fields = { response_type: "code", client_id: client.id, redirect_uri: client.redirectUris[0]!, state: "original-state",
        code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256", scope: "mail.read", resource: config.resource };
      const get = httpFake(`/oauth/authorize?${new URLSearchParams(fields)}`, { cookie: `om_session=${session.token}` });
      await handler(get.req, get.res);
      expect(get.state.status).toBe(200);
      expect(get.state.body).toContain("otherwise your assistant will see no mail");
      expect(get.state.body).toContain('href="/dashboard"');
      const post = httpFake("/oauth/authorize", { method: "POST", cookie: `om_session=${session.token}`, fields: { ...fields, _csrf: session.csrfSecret, decision: "allow" } });
      await handler(post.req, post.res);
      expect(post.state.status).toBe(200);
      const callback = new URL((post.state.headers.get("refresh") as string).slice("0; url=".length));
      expect(callback.origin + callback.pathname).toBe(fields.redirect_uri);
      expect(callback.searchParams.get("state")).toBe("original-state");
      expect(callback.searchParams.get("code")).toBeTruthy();
      const exchange = httpFake("/oauth/token", { method: "POST", fields: { grant_type: "authorization_code", client_id: client.id,
        code: callback.searchParams.get("code")!, redirect_uri: fields.redirect_uri, code_verifier: verifier, resource: config.resource } });
      await handler(exchange.req, exchange.res);
      expect(exchange.state.status).toBe(200);
      expect(JSON.parse(exchange.state.body).access_token).toBeTruthy();
    } finally { db.close(); }
  });

  it("records login/signup outcomes without identity dimensions and preserves the signup OAuth continuation", async () => {
    const db = openDatabase(":memory:"); migrate(db);
    try {
      const metrics: Metric[] = [];
      const handler = createWebHandler({ db, masterKey: Buffer.alloc(32, 2), imap: forbiddenImap, smtp, secureCookies: false,
        trustProxy: false, allowInsecureLocalhost: false, bodyLimit: 1024 * 1024, authRateLimit: { limit: 2, windowMs: 60_000 },
        metrics: { record: (m) => metrics.push(m) } });
      const submit = async (path: string, fields: Record<string, string>) => {
        const call = httpFake(path, { method: "POST", cookie: "om_csrf=csrf", fields: { _csrf: "csrf", ...fields } });
        await handler(call.req, call.res); return call.state;
      };
      const signedUp = await submit("/signup", { email: "new@example.com", password: "test-password", next: "/oauth/authorize?state=kept" });
      expect(signedUp.status).toBe(303);
      expect(signedUp.headers.get("location")).toBe("/oauth/authorize?state=kept");
      expect((await submit("/signup", { email: "invalid", password: "x" })).status).toBe(400);
      expect((await submit("/signup", { email: "unknown@example.com", password: "test-password" })).status).toBe(429);
      expect((await submit("/login", { email: "new@example.com", password: "wrong" })).status).toBe(401);
      expect((await submit("/login", { email: "new@example.com", password: "test-password" })).status).toBe(303);
      expect((await submit("/login", { email: "new@example.com", password: "test-password" })).status).toBe(429);
      expect(metrics).toEqual([
        { kind: "auth", name: "signup", outcome: "ok" }, { kind: "auth", name: "signup", outcome: "failed" },
        { kind: "auth", name: "signup", outcome: "rate_limited" }, { kind: "auth", name: "login", outcome: "failed" },
        { kind: "auth", name: "login", outcome: "ok" }, { kind: "auth", name: "login", outcome: "rate_limited" },
      ]);
      expect(JSON.stringify(metrics)).not.toContain("new@example.com");
    } finally { db.close(); }
  });

  it("shows the next step on an empty dashboard and records safe IMAP/SMTP form outcomes", async () => {
    const db = openDatabase(":memory:"); migrate(db);
    const masterKey = Buffer.alloc(32, 2);
    try {
      const user = await users.create(db, masterKey, { email: "ada@example.com", password: "test-login-password" });
      const session = createSession(db, user.id);
      const metrics: Metric[] = [];
      let part = "IMAP";
      const imap = { ...forbiddenImap, async withClient<T>(_account: unknown, fn: (s: never) => Promise<T>) {
        if (part === "IMAP") throw Object.assign(new Error("private.example.com ada@example.com"), { authenticationFailed: true });
        return fn({} as never);
      } };
      const handler = createWebHandler({ db, masterKey, imap, smtp: { ...smtp, async verify() {
        if (part === "SMTP") throw Object.assign(new Error("private.example.com ada@example.com"), { code: "ETIMEDOUT" });
      } }, secureCookies: false, trustProxy: false, allowInsecureLocalhost: false, bodyLimit: 1024 * 1024,
      metrics: { record: (m) => metrics.push(m) } });
      const dash = httpFake("/dashboard", { cookie: `om_session=${session.token}` }); await handler(dash.req, dash.res);
      expect(dash.state.body).toContain("Next step: add your mailbox");
      expect(dash.state.body).toContain('href="#account-form"');
      expect(dash.state.body).toContain("Workspace admins may disable it");
      for (const path of ["/accounts/test", "/accounts"]) {
        for (part of ["IMAP", "SMTP", "ok"]) {
          const call = httpFake(path, { method: "POST", cookie: `om_session=${session.token}`, fields: { _csrf: session.csrfSecret,
            name: `${path}-${part}`, email: "mailbox@example.com", password: account.password, preset: "gmail", smtp_host: "smtp.gmail.com" } });
          await handler(call.req, call.res);
          expect(call.state.status).toBe(part === "IMAP" ? 400 : part === "SMTP" ? (path === "/accounts" ? 200 : 400) : (path === "/accounts" ? 303 : 200));
          if (part === "SMTP") {
            expect(call.state.body).toContain("Reading works");
            expect(call.state.body).toContain("Sending would not work");
            expect(call.state.body).toContain("SMTP:");
          }
          expect(call.state.body).not.toContain("private.example.com");
          expect(call.state.body).not.toContain(account.password);
        }
      }
      expect(metrics.map((m) => m.outcome)).toEqual(["imap:auth_failed", "smtp:timeout", "ok", "imap:auth_failed", "ok", "smtp:timeout", "ok"]);
      expect(db.prepare("SELECT send_enabled FROM mail_accounts").get()).toEqual({ send_enabled: 0 });
    } finally { db.close(); }
  });
});
