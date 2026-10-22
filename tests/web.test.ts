import { once } from "node:events";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { generateTestMasterKey, loadMasterKey } from "../src/crypto/index.js";
import { migrate, openDatabase } from "../src/db/index.js";
import type { ImapGateway } from "../src/mail/imap-gateway.js";
import { createSmtpGateway, type SmtpGateway } from "../src/mail/smtp-gateway.js";
import { createMemorySendRecorder } from "../src/services/send-log.js";
import { mailAccounts } from "../src/services/index.js";
import { CONTENT_SECURITY_POLICY, HSTS_VALUE, createWebHandler } from "../src/web/index.js";
import { authenticateDatabaseKey, createOpenMailServer } from "../src/server/index.js";
import { SqliteCredentialStore } from "../src/store/index.js";
import { CookieJar, csrfFromHtml, fetchJar, readHtml } from "./helpers/cookie-jar.js";

const PASSWORD = "correct-horse-battery";
const PUBLIC_URL = "https://mcp.example.test";

const imap: ImapGateway = {
  withClient() {
    return Promise.reject(new Error("IMAP must not run in web unit tests"));
  },
  withMailbox() {
    return Promise.reject(new Error("IMAP must not run in web unit tests"));
  },
  appendMessage() {
    return Promise.reject(new Error("IMAP must not run in web unit tests"));
  },
};

describe("web setup app", () => {
  let db: Database | undefined;
  let server: Server | undefined;
  let port = 0;
  let master: Buffer;

  afterEach(async () => {
    if (server) {
      const closing = server;
      server = undefined;
      await new Promise<void>((resolve, reject) => closing.close((err) => (err ? reject(err) : resolve())));
    }
    db?.close();
    db = undefined;
  });

  it("signs up, logs in, rejects a wrong password, and logs out", async () => {
    const base = await start();
    const jar = new CookieJar();

    const signupGet = await fetchJar(jar, `${base}/signup`);
    expect(signupGet.status).toBe(200);
    expectSecurityHeaders(signupGet, true);
    const signupHtml = await readHtml(signupGet);
    const signupCsrf = csrfFromHtml(signupHtml);

    const signedUp = await fetchJar(jar, `${base}/signup`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        _csrf: signupCsrf,
        email: "ada@example.com",
        password: PASSWORD,
      }),
    });
    expect(signedUp.status).toBe(303);
    expect(signedUp.headers.get("location")).toBe("/dashboard");
    expect(jar.get("om_session")).toBeTruthy();

    const dash = await fetchJar(jar, `${base}/dashboard`);
    expect(dash.status).toBe(200);
    const dashHtml = await readHtml(dash);
    expect(dashHtml).toContain("ada@example.com");
    expect(dashHtml).toContain("Connect to Grok Bot");
    expect(dashHtml).toContain(`${PUBLIC_URL}/mcp`);
    expect(dashHtml).toContain("Authorization: Bearer &lt;your key&gt;");
    expect(dashHtml).not.toContain(PASSWORD);
    const logoutCsrf = csrfFromHtml(dashHtml);

    const loggedOut = await fetchJar(jar, `${base}/logout`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ _csrf: logoutCsrf }),
    });
    expect(loggedOut.status).toBe(303);
    expect(jar.get("om_session")).toBeUndefined();

    const loginGet = await fetchJar(jar, `${base}/login`);
    const loginHtml = await readHtml(loginGet);
    const loginCsrf = csrfFromHtml(loginHtml);

    const wrong = await fetchJar(jar, `${base}/login`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        _csrf: loginCsrf,
        email: "ada@example.com",
        password: "wrong-password-value",
      }),
    });
    expect(wrong.status).toBe(401);
    const wrongHtml = await readHtml(wrong);
    expect(wrongHtml).toContain("Email or password is incorrect");
    expect(wrongHtml).not.toContain("wrong-password-value");
    expect(wrongHtml).not.toContain(`value="${PASSWORD}"`);

    const loginAgain = await fetchJar(jar, `${base}/login`);
    const ok = await fetchJar(jar, `${base}/login`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        _csrf: csrfFromHtml(await readHtml(loginAgain)),
        email: "ada@example.com",
        password: PASSWORD,
      }),
    });
    expect(ok.status).toBe(303);
    expect(ok.headers.get("location")).toBe("/dashboard");
    expect(jar.get("om_session")).toBeTruthy();
  });

  it("rejects missing or wrong CSRF with 403", async () => {
    const base = await start();
    const jar = new CookieJar();
    const signupGet = await fetchJar(jar, `${base}/signup`);
    const csrf = csrfFromHtml(await readHtml(signupGet));

    const missing = await fetchJar(jar, `${base}/signup`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ email: "eve@example.com", password: PASSWORD }),
    });
    expect(missing.status).toBe(403);

    const wrong = await fetchJar(jar, `${base}/signup`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        _csrf: "not-the-csrf-token",
        email: "eve@example.com",
        password: PASSWORD,
      }),
    });
    expect(wrong.status).toBe(403);

    const ok = await fetchJar(jar, `${base}/signup`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        _csrf: csrf,
        email: "eve@example.com",
        password: PASSWORD,
      }),
    });
    expect(ok.status).toBe(303);
  });

  it("rate limits login attempts with 429", async () => {
    const base = await start({ authLimit: 3 });
    const jar = new CookieJar();
    await signup(jar, base, "rate@example.com", PASSWORD);
    const dash = await fetchJar(jar, `${base}/dashboard`);
    await fetchJar(jar, `${base}/logout`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ _csrf: csrfFromHtml(await readHtml(dash)) }),
    });

    for (let i = 0; i < 3; i += 1) {
      const loginGet = await fetchJar(jar, `${base}/login`);
      const attempt = await fetchJar(jar, `${base}/login`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          _csrf: csrfFromHtml(await readHtml(loginGet)),
          email: "rate@example.com",
          password: "definitely-wrong-password",
        }),
      });
      expect(attempt.status).toBe(401);
    }

    const loginGet = await fetchJar(jar, `${base}/login`);
    const limited = await fetchJar(jar, `${base}/login`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        _csrf: csrfFromHtml(await readHtml(loginGet)),
        email: "rate@example.com",
        password: PASSWORD,
      }),
    });
    expect(limited.status).toBe(429);
  });

  it("serves security headers on healthz and web pages", async () => {
    const base = await start();
    const health = await fetch(`${base}/healthz`);
    expect(health.status).toBe(200);
    expectSecurityHeaders(health, true);

    const home = await fetch(`${base}/`);
    expect(home.status).toBe(200);
    expectSecurityHeaders(home, true);
    expect(await home.text()).toContain("Sign up");
  });

  it("serves landing, privacy, terms, reviewer guide and logo", async () => {
    const base = await start();
    const home = await (await fetch(`${base}/`)).text();
    expect(home).toContain("No email stored");
    expect(home).toContain('property="og:image" content="https://mcp.openmail.tools/og.png"');
    expect(home).toContain("https://mcp.openmail.tools/mcp");
    expect(home).toContain('href="/signup"');
    expect(home).not.toMatch(/style="/);
    expect(home).not.toMatch(/<script>(?!<)/);
    expect(home).toContain("Read-only");
    expect(home).toContain('href="/privacy"');
    expect(home).toContain('rel="icon"');
    expect(home).toContain('src="/logo.svg"');
    for (const path of ["/privacy", "/terms", "/reviewers", "/support"]) {
      const page = await fetch(`${base}${path}`);
      expect(page.status).toBe(200);
      expectSecurityHeaders(page, true);
      const html = await page.text();
      expect(html).toContain("support@openmail.tools");
    }
    const privacy = await (await fetch(`${base}/privacy`)).text();
    expect(privacy).toContain("What OpenMail returns to your assistant");
    expect(privacy).toContain("14 days");
    expect(privacy).toContain("within 30 days");
    const support = await (await fetch(`${base}/support`)).text();
    expect(support).toContain("https://github.com/webumer/openmail/issues");
    expect(support).toContain("app password");
    expect(home).toContain('href="/support"');
    const guide = await (await fetch(`${base}/reviewers`)).text();
    expect(guide).toContain("<h1>OpenMail");
    expect(guide).toContain("<table>");
    expect(guide).not.toMatch(/password\s*[:=]\s*\S/i);
    const svg = await fetch(`${base}/logo.svg`);
    expect(svg.status).toBe(200);
    expect(svg.headers.get("content-type")).toBe("image/svg+xml");
    const png = await fetch(`${base}/logo.png`);
    expect(png.headers.get("content-type")).toBe("image/png");
    expect(Buffer.from(await png.arrayBuffer()).subarray(1, 4).toString()).toBe("PNG");
    expect((await fetch(`${base}/favicon.ico`)).status).toBe(200);
    const og = await fetch(`${base}/og.png`);
    expect(og.headers.get("content-type")).toBe("image/png");
    expect((await fetch(`${base}/static/site.js`)).headers.get("content-type")).toContain("javascript");
  });

  it("refuses private custom hosts before any IMAP login and rate limits mailbox probes", async () => {
    const base = await start({ probeLimit: 2 });
    const jar = new CookieJar();
    await signup(jar, base, "probe@example.com", PASSWORD);
    const submit = async (host: string, port = "993") => {
      const dash = await fetchJar(jar, `${base}/dashboard`);
      return fetchJar(jar, `${base}/accounts/test`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          _csrf: csrfFromHtml(await readHtml(dash)),
          name: "Probe",
          email: "probe@example.com",
          username: "",
          password: "mailbox-secret-value",
          preset: "custom",
          zoho_region: "",
          imap_host: host,
          imap_port: port,
          imap_secure: "on",
          smtp_host: "203.0.113.9",
          smtp_port: "465",
          smtp_secure: "on",
          smtp_starttls: "",
        }),
      });
    };
    const internal = await submit("10.1.2.3");
    expect(internal.status).toBe(400);
    const internalHtml = await readHtml(internal);
    expect(internalHtml).toContain("public internet address");
    expect(internalHtml).not.toContain("mailbox-secret-value");
    const badPort = await submit("198.51.100.7", "22");
    expect(badPort.status).toBe(400);
    expect(await readHtml(badPort)).toContain("IMAP port must be one of");
    const limited = await submit("10.1.2.3");
    expect(limited.status).toBe(429);
  });

  it("shows an in-progress send and rate limits turning sending on", async () => {
    let verifies = 0;
    const smtp: SmtpGateway = {
      async send() {
        return { messageId: "m" };
      },
      async verify() {
        verifies += 1;
      },
    };
    const base = await start({ probeLimit: 1, smtp });
    const jar = new CookieJar();
    await signup(jar, base, "send-limit@example.com", PASSWORD);
    const user = db?.prepare("SELECT id FROM users WHERE email = ?").get("send-limit@example.com") as { id: string };
    const added = mailAccounts.add(db as NonNullable<typeof db>, master, {
      userId: user.id,
      name: "Work",
      email: "ada@example.com",
      preset: "migadu",
      password: "mailbox-secret",
    });
    db?.prepare(
      `INSERT INTO send_log (
         id, user_id, account_id, account_label, created_at, status, recipients, message_id, error_code, via
       ) VALUES (?, ?, ?, ?, ?, 'failed', 1, NULL, 'in_progress', 'api_key:Laptop')`,
    ).run("send-1", user.id, added.id, "Work", "2026-10-22T12:00:00.000Z");
    const dash = await fetchJar(jar, `${base}/dashboard`);
    const html = await readHtml(dash);
    expect(html).toContain("Status</span> in progress");

    const off = await fetchJar(jar, `${base}/accounts/${added.id}/sending`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ _csrf: csrfFromHtml(html), enabled: "0" }),
    });
    expect(off.status).toBe(303);
    expect(verifies).toBe(0);

    const probed = await fetchJar(jar, `${base}/accounts/test`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        _csrf: csrfFromHtml(await readHtml(await fetchJar(jar, `${base}/dashboard`))),
        name: "Probe",
        email: "ada@example.com",
        username: "",
        password: "mailbox-secret-value",
        preset: "custom",
        zoho_region: "",
        imap_host: "10.1.2.3",
        imap_port: "993",
        imap_secure: "on",
        smtp_host: "203.0.113.9",
        smtp_port: "465",
        smtp_secure: "on",
        smtp_starttls: "",
      }),
    });
    expect(probed.status).toBe(400);
    const enabled = await fetchJar(jar, `${base}/accounts/${added.id}/sending`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        _csrf: csrfFromHtml(await readHtml(await fetchJar(jar, `${base}/dashboard`))),
        enabled: "1",
      }),
    });
    expect(enabled.status).toBe(429);
    expect(verifies).toBe(0);
  });

  async function start(options?: { authLimit?: number; probeLimit?: number; smtp?: SmtpGateway }): Promise<string> {
    master = loadMasterKey(generateTestMasterKey());
    db = openDatabase(":memory:");
    migrate(db);
    const web = createWebHandler({
      db,
      masterKey: master,
      imap,
      smtp: options?.smtp ?? createSmtpGateway(),
      publicUrl: PUBLIC_URL,
      trustProxy: false,
      allowInsecureLocalhost: false,
      secureCookies: false,
      bodyLimit: 1024 * 1024,
      ...(options?.authLimit
        ? { authRateLimit: { limit: options.authLimit, windowMs: 60_000 } }
        : {}),
      ...(options?.probeLimit ? { probeRateLimit: { limit: options.probeLimit, windowMs: 60_000 } } : {}),
    });
    server = createOpenMailServer({
      store: new SqliteCredentialStore(db, master),
      imap,
      smtp: createSmtpGateway(),
      sends: createMemorySendRecorder(),
      authenticate: (header) => authenticateDatabaseKey(db!, header),
      web,
      security: { publicUrl: PUBLIC_URL, trustProxy: false },
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    port = (server.address() as AddressInfo).port;
    return `http://127.0.0.1:${port}`;
  }

  async function signup(jar: CookieJar, base: string, email: string, password: string): Promise<void> {
    const get = await fetchJar(jar, `${base}/signup`);
    const response = await fetchJar(jar, `${base}/signup`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        _csrf: csrfFromHtml(await readHtml(get)),
        email,
        password,
      }),
    });
    expect(response.status).toBe(303);
  }
});

function expectSecurityHeaders(response: Response, hsts: boolean): void {
  expect(response.headers.get("content-security-policy")).toBe(CONTENT_SECURITY_POLICY);
  expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  expect(response.headers.get("x-frame-options")).toBe("DENY");
  if (hsts) expect(response.headers.get("strict-transport-security")).toBe(HSTS_VALUE);
  else expect(response.headers.get("strict-transport-security")).toBeNull();
}
