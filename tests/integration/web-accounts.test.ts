import { once } from "node:events";
import net from "node:net";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { generateTestMasterKey, loadMasterKey } from "../../src/crypto/index.js";
import { migrate, openDatabase } from "../../src/db/index.js";
import { createImapGateway } from "../../src/mail/index.js";
import { createSmtpGateway } from "../../src/mail/smtp-gateway.js";
import { createMemorySendRecorder } from "../../src/services/send-log.js";
import { authenticateDatabaseKey, createOpenMailServer } from "../../src/server/index.js";
import { mailAccounts } from "../../src/services/index.js";
import { SqliteCredentialStore } from "../../src/store/index.js";
import { createWebHandler } from "../../src/web/index.js";
import { CookieJar, csrfFromHtml, fetchJar, readHtml } from "../helpers/cookie-jar.js";

const IMAP_PORT = Number(process.env.OPENMAIL_TEST_IMAP_PORT ?? "13143");
const SMTP_PORT = Number(process.env.OPENMAIL_TEST_SMTP_PORT ?? "13025");
const IMAP_USER = "test";
const IMAP_PASS = "test";
const USER_PASSWORD = "web-account-password";

const live = (await probe(IMAP_PORT)) && (await probe(SMTP_PORT));
if (!live) {
  console.warn(
    `SKIP: GreenMail is unreachable at 127.0.0.1:${IMAP_PORT} (IMAP) and 127.0.0.1:${SMTP_PORT} (SMTP). Run npm run test:integration to start greenmail/standalone.`,
  );
}

describe.skipIf(!live)("web accounts against GreenMail", () => {
  let db: Database;
  let server: Server;
  let base = "";
  let master: Buffer;
  const jar = new CookieJar();

  beforeAll(async () => {
    process.env.OPENMAIL_ALLOW_INSECURE_LOCALHOST = "1";
    master = loadMasterKey(generateTestMasterKey());
    db = openDatabase(":memory:");
    migrate(db);
    const imap = createImapGateway();
    const web = createWebHandler({
      db,
      masterKey: master,
      imap,
      smtp: createSmtpGateway(),
      publicUrl: "https://mcp.openmail.tools",
      trustProxy: false,
      allowInsecureLocalhost: true,
      secureCookies: false,
      bodyLimit: 1024 * 1024,
    });
    server = createOpenMailServer({
      store: new SqliteCredentialStore(db, master, { allowInsecureLocalhost: true }),
      imap,
      smtp: createSmtpGateway(),
      sends: createMemorySendRecorder(),
      authenticate: (header) => authenticateDatabaseKey(db, header),
      web,
      security: { publicUrl: "https://mcp.openmail.tools" },
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const signupGet = await fetchJar(jar, `${base}/signup`);
    const signed = await fetchJar(jar, `${base}/signup`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        _csrf: csrfFromHtml(await readHtml(signupGet)),
        email: "web@example.com",
        password: USER_PASSWORD,
      }),
    });
    expect(signed.status).toBe(303);
  });

  afterAll(async () => {
    if (server) {
      await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    }
    db?.close();
  });

  it("tests IMAP, rejects a bad password without saving, adds and removes an account", async () => {
    const dash = await fetchJar(jar, `${base}/dashboard`);
    expect(dash.status).toBe(200);
    let html = await readHtml(dash);
    const csrf = csrfFromHtml(html);

    const badPassword = "not-the-greenmail-password";
    const bad = await fetchJar(jar, `${base}/accounts`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: accountBody(csrf, badPassword),
    });
    expect(bad.status).toBe(400);
    const badHtml = await readHtml(bad);
    expect(badHtml).not.toContain(badPassword);
    expect(badHtml).not.toMatch(/id="mailbox-password"[^>]*value="/);
    expect(mailAccounts.list(db, userIdFromDb()).length).toBe(0);

    const probe = await fetchJar(jar, `${base}/accounts/test`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: accountBody(csrfFromHtml(badHtml), IMAP_PASS),
    });
    expect(probe.status).toBe(200);
    const probeHtml = await readHtml(probe);
    expect(probeHtml).toContain("Signed in to IMAP");
    expect(probeHtml).not.toMatch(/id="mailbox-password"[^>]*value="/);
    expect(mailAccounts.list(db, userIdFromDb()).length).toBe(0);

    const saved = await fetchJar(jar, `${base}/accounts`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: accountBody(csrfFromHtml(probeHtml), IMAP_PASS),
    });
    expect(saved.status).toBe(303);
    expect(saved.headers.get("location")).toContain("account-added");

    const listed = await fetchJar(jar, `${base}/dashboard`);
    html = await readHtml(listed);
    expect(html).toContain("GreenMail");
    expect(html).toContain("test@example.com");
    expect(html).toContain("127.0.0.1");
    expect(html).not.toContain(USER_PASSWORD);
    expect(html).not.toMatch(/id="mailbox-password"[^>]*value="/);
    // Mailbox secret must not appear as a filled password field (username may be "test").
    expect(html).not.toMatch(new RegExp(`type="password"[^>]*value="${IMAP_PASS}"`));

    const accounts = mailAccounts.list(db, userIdFromDb());
    expect(accounts).toHaveLength(1);
    const accountId = accounts[0]!.id;

    const removed = await fetchJar(jar, `${base}/accounts/${accountId}/delete`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ _csrf: csrfFromHtml(html) }),
    });
    expect(removed.status).toBe(303);
    expect(mailAccounts.list(db, userIdFromDb())).toHaveLength(0);
  });

  it("creates an API key shown once, lists by prefix, and revoke returns MCP 401", async () => {
    const dash = await fetchJar(jar, `${base}/dashboard`);
    const html = await readHtml(dash);
    const created = await fetchJar(jar, `${base}/keys`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        _csrf: csrfFromHtml(html),
        name: "grok",
      }),
    });
    expect(created.status).toBe(200);
    const reveal = await readHtml(created);
    const match = reveal.match(/id="new-api-key">([^<]+)</);
    expect(match?.[1]).toMatch(/^om_/);
    const token = match![1]!;
    const prefix = token.slice(0, 12);
    expect(reveal).toContain(prefix);
    expect(reveal).toContain(`Authorization: Bearer ${token}`);

    const ok = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${token}`,
      },
      body: "{}",
    });
    expect(ok.status).not.toBe(401);

    const after = await fetchJar(jar, `${base}/dashboard`);
    const afterHtml = await readHtml(after);
    expect(afterHtml).toContain(prefix);
    expect(afterHtml).not.toContain(token);

    const keyId = db
      .prepare("SELECT id FROM api_keys WHERE prefix = ?")
      .get(prefix) as { id: string } | undefined;
    expect(keyId?.id).toBeTruthy();

    const revoked = await fetchJar(jar, `${base}/keys/${keyId!.id}/revoke`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ _csrf: csrfFromHtml(afterHtml) }),
    });
    expect(revoked.status).toBe(303);

    const denied = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${token}`,
      },
      body: "{}",
    });
    expect(denied.status).toBe(401);
    expect(await denied.text()).not.toContain(token);
  });

  function userIdFromDb(): string {
    const row = db.prepare("SELECT id FROM users WHERE email = ?").get("web@example.com") as { id: string };
    return row.id;
  }

  function accountBody(csrf: string, password: string): URLSearchParams {
    return new URLSearchParams({
      _csrf: csrf,
      name: "GreenMail",
      email: "test@example.com",
      username: IMAP_USER,
      password,
      preset: "custom",
      zoho_region: "com",
      imap_host: "127.0.0.1",
      imap_port: String(IMAP_PORT),
      smtp_host: "127.0.0.1",
      smtp_port: String(SMTP_PORT),
    });
  }
});

function probe(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port }, () => {
      socket.end();
      resolve(true);
    });
    socket.on("error", () => resolve(false));
    socket.setTimeout(1_000, () => {
      socket.destroy();
      resolve(false);
    });
  });
}
