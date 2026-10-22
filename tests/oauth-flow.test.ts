import { CimdFetchError } from "../src/oauth/cimd-fetch.js";
import { once } from "node:events";
import { createHash, randomBytes } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { generateTestMasterKey, loadMasterKey } from "../src/crypto/index.js";
import { migrate, openDatabase } from "../src/db/index.js";
import type { ImapGateway } from "../src/mail/imap-gateway.js";
import { createSmtpGateway } from "../src/mail/smtp-gateway.js";
import { createMemorySendRecorder } from "../src/services/send-log.js";
import { authenticateDatabaseKey, createOpenMailServer } from "../src/server/index.js";
import { apiKeys, mailAccounts, users } from "../src/services/index.js";
import { SqliteCredentialStore } from "../src/store/index.js";
import { createWebHandler } from "../src/web/index.js";
import { bearerChallenge, createOAuthHandler, deriveOAuthConfig, type OAuthConfig } from "../src/oauth/index.js";
import type { DocumentFetcher, FetchedDocument } from "../src/oauth/cimd-fetch.js";
import { CookieJar, csrfFromHtml, fetchJar, readHtml } from "./helpers/cookie-jar.js";

const PASSWORD = "correct-horse-battery";
const REDIRECT = "https://client.example/callback";

const imap: ImapGateway = {
  withClient() {
    return Promise.reject(new Error("IMAP must not run in OAuth tests"));
  },
  withMailbox() {
    return Promise.reject(new Error("IMAP must not run in OAuth tests"));
  },
  appendMessage() {
    return Promise.reject(new Error("IMAP must not run in OAuth tests"));
  },
};

function pkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

describe("OAuth 2.1 authorization server", () => {
  let db: Database;
  let server: Server;
  let base = "";
  let config: OAuthConfig;
  let master: Buffer;
  let cimdDocs: Map<string, FetchedDocument>;
  let fetchCount = 0;
  let registerLimit = 50;

  const fetcher: DocumentFetcher = async (url) => {
    fetchCount += 1;
    const doc = cimdDocs.get(url.toString());
    if (url.hostname === "internal.example") throw new CimdFetchError("must be a public internet address");
    if (!doc) throw new Error("not found");
    return doc;
  };

  beforeEach(async () => {
    master = loadMasterKey(generateTestMasterKey());
    db = openDatabase(":memory:");
    migrate(db);
    cimdDocs = new Map();
    fetchCount = 0;
    let oauth: ((req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => Promise<boolean>) | undefined;
    const web = createWebHandler({
      db,
      masterKey: master,
      imap,
      smtp: createSmtpGateway(),
      publicUrl: "https://mcp.example.test",
      trustProxy: false,
      allowInsecureLocalhost: false,
      secureCookies: false,
      bodyLimit: 1024 * 1024,
    });
    server = createOpenMailServer({
      store: new SqliteCredentialStore(db, master),
      imap,
      smtp: createSmtpGateway(),
      sends: createMemorySendRecorder(),
      authenticate: (header) => authenticateDatabaseKey(db, header, config.resource),
      web: async (req, res) => (oauth ? await oauth(req, res) : false) || (await web(req, res)),
      challenge: (invalid) => bearerChallenge(config, invalid),
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    config = deriveOAuthConfig(base, { allowHttp: true })!;
    oauth = createOAuthHandler({
      db,
      config,
      fetcher,
      trustProxy: false,
      registerRateLimit: { limit: registerLimit, windowMs: 60_000 },
    });
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    db.close();
    registerLimit = 50;
  });

  async function signup(jar: CookieJar, email: string): Promise<string> {
    const get = await fetchJar(jar, `${base}/signup`);
    const res = await fetchJar(jar, `${base}/signup`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ _csrf: csrfFromHtml(await readHtml(get)), email, password: PASSWORD }),
    });
    expect(res.status).toBe(303);
    const row = db.prepare("SELECT id FROM users WHERE email = ?").get(email) as { id: string };
    return row.id;
  }

  function addMailbox(userId: string, name: string, email: string): void {
    mailAccounts.add(db, master, { userId, name, email, preset: "migadu", password: `${name}-mailbox-secret` });
  }

  async function register(body: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const res = await fetch(`${base}/oauth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_name: "Test Client", redirect_uris: [REDIRECT], ...body }),
    });
    expect(res.status).toBe(201);
    return (await res.json()) as Record<string, unknown>;
  }

  function authorizeUrl(params: Record<string, string>): string {
    return `${base}/oauth/authorize?${new URLSearchParams(params).toString()}`;
  }

  function standardParams(clientId: string, challenge: string, extra: Record<string, string> = {}): Record<string, string> {
    return {
      response_type: "code",
      client_id: clientId,
      redirect_uri: REDIRECT,
      code_challenge: challenge,
      code_challenge_method: "S256",
      state: "state-123",
      scope: "mail.read",
      resource: config.resource,
      ...extra,
    };
  }

  /** GET authorize (already logged in) → consent → Allow. Returns the redirect Location. */
  async function consent(
    jar: CookieJar,
    params: Record<string, string>,
    decision = "allow",
    extra: Record<string, string> = {},
  ): Promise<URL> {
    const page = await fetchJar(jar, authorizeUrl(params));
    expect(page.status).toBe(200);
    const html = await readHtml(page);
    const form = new URLSearchParams();
    for (const match of html.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g)) {
      form.set(match[1] as string, decodeEntities(match[2] as string));
    }
    form.set("decision", decision);
    for (const [name, value] of Object.entries(extra)) form.set(name, value);
    const post = await fetchJar(jar, `${base}/oauth/authorize`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form,
    });
    expect(post.status).toBe(303);
    return new URL(post.headers.get("location") as string);
  }

  async function token(form: Record<string, string>, headers: Record<string, string> = {}): Promise<{ status: number; body: Record<string, unknown> }> {
    const res = await fetch(`${base}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
      body: new URLSearchParams(form),
    });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  }

  async function fullGrant(jar: CookieJar, clientId: string): Promise<{ access: string; refresh: string }> {
    const { verifier, challenge } = pkce();
    const location = await consent(jar, standardParams(clientId, challenge));
    const code = location.searchParams.get("code") as string;
    const result = await token({
      grant_type: "authorization_code",
      client_id: clientId,
      code,
      redirect_uri: REDIRECT,
      code_verifier: verifier,
      resource: config.resource,
    });
    expect(result.status).toBe(200);
    return { access: result.body.access_token as string, refresh: result.body.refresh_token as string };
  }

  async function listAccounts(bearer: string): Promise<{ ok: boolean; status?: number; names?: string[] }> {
    const client = new Client({ name: "test", version: "1" });
    const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${bearer}` } },
    });
    try {
      await client.connect(transport);
      const result = await client.callTool({ name: "list_accounts", arguments: {} });
      const data = result.structuredContent as { data: Array<{ label: string }> };
      return { ok: true, names: data.data.map((a) => a.label) };
    } catch {
      const res = await fetch(`${base}/mcp`, {
        method: "POST",
        headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      });
      return { ok: false, status: res.status };
    } finally {
      await client.close().catch(() => undefined);
    }
  }

  it("publishes protected resource and authorization server metadata", async () => {
    for (const path of ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"]) {
      const res = await fetch(`${base}${path}`);
      expect(res.status).toBe(200);
      expect(res.headers.get("access-control-allow-origin")).toBe("*");
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.resource).toBe(`${base}/mcp`);
      expect(body.authorization_servers).toEqual([base]);
      expect(body.scopes_supported).toEqual(["mail.read", "mail.send"]);
    }
    const asm = (await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json()) as Record<string, unknown>;
    expect(asm.issuer).toBe(base);
    expect(asm.code_challenge_methods_supported).toEqual(["S256"]);
    expect(asm.client_id_metadata_document_supported).toBe(true);
    expect(asm.authorization_response_iss_parameter_supported).toBe(true);
    expect(asm.token_endpoint_auth_methods_supported).toContain("none");
    expect(asm.registration_endpoint).toBe(`${base}/oauth/register`);
    expect(asm.revocation_endpoint).toBe(`${base}/oauth/revoke`);
    const preflight = await fetch(`${base}/oauth/token`, { method: "OPTIONS" });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBe("*");
  });

  it("answers /mcp without a token with a 401 that points at the metadata", async () => {
    const res = await fetch(`${base}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(res.status).toBe(401);
    const header = res.headers.get("www-authenticate") ?? "";
    expect(header).toContain(`resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"`);
    expect(header).toContain('scope="mail.read mail.send"');
    expect(header).not.toContain("invalid_token");
    expect(res.headers.get("access-control-expose-headers")).toContain("www-authenticate");
    const bad = await fetch(`${base}/mcp`, { method: "POST", headers: { authorization: "Bearer oma_nope" }, body: "{}" });
    expect(bad.status).toBe(401);
    expect(bad.headers.get("www-authenticate")).toContain('error="invalid_token"');
    const preflight = await fetch(`${base}/mcp`, { method: "OPTIONS" });
    expect(preflight.status).toBe(204);
  });

  it("validates dynamic client registration", async () => {
    const ok = await register({ redirect_uris: [REDIRECT, "http://localhost:6274/oauth/callback"] });
    expect(String(ok.client_id)).toMatch(/^omcl_/);
    expect(ok.token_endpoint_auth_method).toBe("none");
    expect(ok.client_secret).toBeUndefined();
    const bad = async (body: Record<string, unknown>) => {
      const res = await fetch(`${base}/oauth/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      return { status: res.status, body: (await res.json()) as Record<string, unknown> };
    };
    expect((await bad({ redirect_uris: ["http://evil.example/cb"] })).body.error).toBe("invalid_redirect_uri");
    expect((await bad({ redirect_uris: ["https://a.example/cb#x"] })).body.error).toBe("invalid_redirect_uri");
    expect((await bad({ redirect_uris: ["javascript:alert(1)"] })).body.error).toBe("invalid_redirect_uri");
    expect((await bad({ redirect_uris: [] })).body.error).toBe("invalid_redirect_uri");
    expect((await bad({ redirect_uris: Array.from({ length: 11 }, (_, i) => `https://a.example/${i}`) })).body.error).toBe("invalid_redirect_uri");
    expect((await bad({ redirect_uris: [REDIRECT], grant_types: ["client_credentials"] })).body.error).toBe("invalid_client_metadata");
    expect((await bad({ redirect_uris: [REDIRECT], response_types: ["token"] })).body.error).toBe("invalid_client_metadata");
    expect((await bad({ redirect_uris: [REDIRECT], token_endpoint_auth_method: "private_key_jwt" })).body.error).toBe("invalid_client_metadata");
    const wrongType = await fetch(`${base}/oauth/register`, { method: "POST", headers: { "content-type": "text/plain" }, body: "{}" });
    expect(wrongType.status).toBe(400);
  });

  it("rate limits registration per address", async () => {
    // Fresh handler with a tiny limit.
    const limited = createOAuthHandler({ db, config, fetcher, trustProxy: false, registerRateLimit: { limit: 2, windowMs: 60_000 } });
    const statuses: number[] = [];
    const { createServer } = await import("node:http");
    const s = createServer((req, res) => void limited(req, res));
    s.listen(0, "127.0.0.1");
    await once(s, "listening");
    const url = `http://127.0.0.1:${(s.address() as AddressInfo).port}/oauth/register`;
    for (let i = 0; i < 3; i += 1) {
      const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ redirect_uris: [REDIRECT] }) });
      statuses.push(res.status);
    }
    await new Promise<void>((resolve) => s.close(() => resolve()));
    expect(statuses).toEqual([201, 201, 429]);
  });

  it("runs the full flow: login redirect, consent, code, tokens, MCP, refresh rotation", async () => {
    const client = await register();
    const clientId = client.client_id as string;
    const jar = new CookieJar();
    const userId = await signup(jar, "ada@example.com");
    addMailbox(userId, "Ada Work", "ada@work.example");
    jar.clear();

    const { verifier, challenge } = pkce();
    const params = standardParams(clientId, challenge);
    const first = await fetchJar(jar, authorizeUrl(params));
    expect(first.status).toBe(303);
    const loginLocation = first.headers.get("location") as string;
    expect(loginLocation.startsWith("/login?next=")).toBe(true);
    const loginPage = await fetchJar(jar, `${base}${loginLocation}`);
    const loginHtml = await readHtml(loginPage);
    expect(loginHtml).toContain('name="next"');
    const next = new URL(loginLocation, base).searchParams.get("next") as string;
    const loggedIn = await fetchJar(jar, `${base}/login`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ _csrf: csrfFromHtml(loginHtml), email: "ada@example.com", password: PASSWORD, next }),
    });
    expect(loggedIn.status).toBe(303);
    expect(loggedIn.headers.get("location")).toBe(next);

    const consentRes = await fetchJar(jar, `${base}${next}`);
    expect(consentRes.status).toBe(200);
    const csp = consentRes.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("form-action 'self' https://client.example");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(consentRes.headers.get("x-frame-options")).toBe("DENY");
    const html = await readHtml(consentRes);
    expect(html).toContain("Test Client");
    expect(html).toContain("wants read-only access to your OpenMail mailboxes");
    expect(html).toContain("ada@work.example");
    expect(html).toContain("not verified");
    expect(html).toContain("client.example");

    const location = await consent(jar, params);
    expect(location.origin + location.pathname).toBe(REDIRECT);
    expect(location.searchParams.get("state")).toBe("state-123");
    expect(location.searchParams.get("iss")).toBe(base);
    const code = location.searchParams.get("code") as string;
    expect(code).toMatch(/^omc_/);

    const exchanged = await token({
      grant_type: "authorization_code",
      client_id: clientId,
      code,
      redirect_uri: REDIRECT,
      code_verifier: verifier,
      resource: config.resource,
    });
    expect(exchanged.status).toBe(200);
    expect(exchanged.body.token_type).toBe("Bearer");
    expect(exchanged.body.expires_in).toBe(3600);
    expect(exchanged.body.scope).toBe("mail.read");
    const access = exchanged.body.access_token as string;
    const refresh = exchanged.body.refresh_token as string;
    expect(access).toMatch(/^oma_/);
    expect(refresh).toMatch(/^omr_/);

    // Tokens are stored only as hashes.
    const stored = db.prepare("SELECT token_hash FROM oauth_tokens").all() as Array<{ token_hash: string }>;
    expect(stored.some((row) => row.token_hash === access || row.token_hash === refresh)).toBe(false);

    expect(await listAccounts(access)).toEqual({ ok: true, names: ["Ada Work"] });

    // Refresh rotates both tokens.
    const refreshed = await token({ grant_type: "refresh_token", client_id: clientId, refresh_token: refresh });
    expect(refreshed.status).toBe(200);
    const access2 = refreshed.body.access_token as string;
    const refresh2 = refreshed.body.refresh_token as string;
    expect(refresh2).not.toBe(refresh);
    expect((await listAccounts(access2)).ok).toBe(true);
    // The previous access token is retired by the rotation.
    expect(await listAccounts(access)).toEqual({ ok: false, status: 401 });

    // Reusing the old refresh token revokes the whole connection.
    const reuse = await token({ grant_type: "refresh_token", client_id: clientId, refresh_token: refresh });
    expect(reuse.status).toBe(400);
    expect(reuse.body.error).toBe("invalid_grant");
    expect(await listAccounts(access2)).toEqual({ ok: false, status: 401 });
    const after = await token({ grant_type: "refresh_token", client_id: clientId, refresh_token: refresh2 });
    expect(after.body.error).toBe("invalid_grant");
  });

  it("rejects a wrong PKCE verifier, missing PKCE and plain PKCE", async () => {
    const clientId = (await register()).client_id as string;
    const jar = new CookieJar();
    await signup(jar, "ada@example.com");
    const { challenge } = pkce();
    const location = await consent(jar, standardParams(clientId, challenge));
    const wrong = await token({
      grant_type: "authorization_code",
      client_id: clientId,
      code: location.searchParams.get("code") as string,
      redirect_uri: REDIRECT,
      code_verifier: pkce().verifier,
    });
    expect(wrong.status).toBe(400);
    expect(wrong.body.error).toBe("invalid_grant");
    const missingVerifier = await token({
      grant_type: "authorization_code",
      client_id: clientId,
      code: location.searchParams.get("code") as string,
      redirect_uri: REDIRECT,
    });
    expect(missingVerifier.body.error).toBe("invalid_grant");

    const noChallenge = standardParams(clientId, challenge);
    delete (noChallenge as Record<string, string | undefined>).code_challenge;
    const r1 = await fetchJar(jar, authorizeUrl(noChallenge));
    expect(r1.status).toBe(303);
    const l1 = new URL(r1.headers.get("location") as string);
    expect(l1.searchParams.get("error")).toBe("invalid_request");
    expect(l1.searchParams.get("state")).toBe("state-123");
    expect(l1.searchParams.get("iss")).toBe(base);
    const plain = await fetchJar(jar, authorizeUrl(standardParams(clientId, challenge, { code_challenge_method: "plain" })));
    expect(new URL(plain.headers.get("location") as string).searchParams.get("error")).toBe("invalid_request");
    const badType = await fetchJar(jar, authorizeUrl(standardParams(clientId, challenge, { response_type: "token" })));
    expect(new URL(badType.headers.get("location") as string).searchParams.get("error")).toBe("unsupported_response_type");
    const badScope = await fetchJar(jar, authorizeUrl(standardParams(clientId, challenge, { scope: "mail.write" })));
    expect(new URL(badScope.headers.get("location") as string).searchParams.get("error")).toBe("invalid_scope");
    const badResource = await fetchJar(jar, authorizeUrl(standardParams(clientId, challenge, { resource: "https://evil.example/mcp" })));
    expect(new URL(badResource.headers.get("location") as string).searchParams.get("error")).toBe("invalid_target");
    const dup = await fetchJar(jar, `${authorizeUrl(standardParams(clientId, challenge))}&scope=mail.read`);
    expect(new URL(dup.headers.get("location") as string).searchParams.get("error")).toBe("invalid_request");
  });

  it("never redirects to an unregistered redirect_uri and checks it again at the token endpoint", async () => {
    const clientId = (await register()).client_id as string;
    const jar = new CookieJar();
    await signup(jar, "ada@example.com");
    const { verifier, challenge } = pkce();
    for (const evil of ["https://evil.example/callback", "https://client.example/callback/../evil", "https://client.example/callback?x=1", "http://client.example/callback"]) {
      const res = await fetchJar(jar, authorizeUrl(standardParams(clientId, challenge, { redirect_uri: evil })));
      expect(res.status).toBe(400);
      expect(res.headers.get("location")).toBeNull();
      expect(await readHtml(res)).toContain("Invalid redirect");
    }
    const unknownClient = await fetchJar(jar, authorizeUrl(standardParams("omcl_unknown", challenge)));
    expect(unknownClient.status).toBe(400);
    expect(unknownClient.headers.get("location")).toBeNull();

    const location = await consent(jar, standardParams(clientId, challenge));
    const mismatch = await token({
      grant_type: "authorization_code",
      client_id: clientId,
      code: location.searchParams.get("code") as string,
      redirect_uri: "https://client.example/other",
      code_verifier: verifier,
    });
    expect(mismatch.body.error).toBe("invalid_grant");
  });

  it("rejects code reuse and revokes tokens issued from that code", async () => {
    const clientId = (await register()).client_id as string;
    const jar = new CookieJar();
    const userId = await signup(jar, "ada@example.com");
    addMailbox(userId, "Ada", "ada@work.example");
    const { verifier, challenge } = pkce();
    const location = await consent(jar, standardParams(clientId, challenge));
    const form = {
      grant_type: "authorization_code",
      client_id: clientId,
      code: location.searchParams.get("code") as string,
      redirect_uri: REDIRECT,
      code_verifier: verifier,
    };
    const first = await token(form);
    expect(first.status).toBe(200);
    const second = await token(form);
    expect(second.body.error).toBe("invalid_grant");
    expect(await listAccounts(first.body.access_token as string)).toEqual({ ok: false, status: 401 });
  });

  it("rejects expired codes and expired or revoked access tokens", async () => {
    const clientId = (await register()).client_id as string;
    const jar = new CookieJar();
    const userId = await signup(jar, "ada@example.com");
    addMailbox(userId, "Ada", "ada@work.example");
    const { verifier, challenge } = pkce();
    const location = await consent(jar, standardParams(clientId, challenge));
    db.prepare("UPDATE oauth_codes SET expires_at = ?").run(new Date(Date.now() - 1000).toISOString());
    const expired = await token({
      grant_type: "authorization_code",
      client_id: clientId,
      code: location.searchParams.get("code") as string,
      redirect_uri: REDIRECT,
      code_verifier: verifier,
    });
    expect(expired.body.error).toBe("invalid_grant");

    const tokens = await fullGrant(jar, clientId);
    expect((await listAccounts(tokens.access)).ok).toBe(true);
    db.prepare("UPDATE oauth_tokens SET expires_at = ? WHERE kind = 'access'").run(new Date(Date.now() - 1000).toISOString());
    expect(await listAccounts(tokens.access)).toEqual({ ok: false, status: 401 });

    // Refresh still works after the access token expires.
    const refreshed = await token({ grant_type: "refresh_token", client_id: clientId, refresh_token: tokens.refresh });
    expect(refreshed.status).toBe(200);
    // Revoking the refresh token (RFC 7009) kills the whole grant.
    const revoke = await fetch(`${base}/oauth/revoke`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: clientId, token: refreshed.body.refresh_token as string }),
    });
    expect(revoke.status).toBe(200);
    expect(await listAccounts(refreshed.body.access_token as string)).toEqual({ ok: false, status: 401 });
    // Unknown tokens are accepted silently.
    const unknown = await fetch(`${base}/oauth/revoke`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: clientId, token: "omr_unknown" }),
    });
    expect(unknown.status).toBe(200);
  });

  it("lists connected apps on the dashboard and disconnects them", async () => {
    const clientId = (await register({ client_name: "Claude <b>x</b>" })).client_id as string;
    const jar = new CookieJar();
    const userId = await signup(jar, "ada@example.com");
    addMailbox(userId, "Ada", "ada@work.example");
    const tokens = await fullGrant(jar, clientId);
    const dash = await readHtml(await fetchJar(jar, `${base}/dashboard`));
    expect(dash).toContain("Connected apps");
    expect(dash).toContain("Claude &lt;b&gt;x&lt;/b&gt;");
    expect(dash).not.toContain("<b>x</b>");
    const match = dash.match(/action="\/apps\/([0-9a-f-]{36})\/revoke"/);
    expect(match).not.toBeNull();
    const csrf = csrfFromHtml(dash);
    const noCsrf = await fetchJar(jar, `${base}/apps/${match![1]}/revoke`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({}),
    });
    expect(noCsrf.status).toBe(403);
    const revoked = await fetchJar(jar, `${base}/apps/${match![1]}/revoke`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ _csrf: csrf }),
    });
    expect(revoked.status).toBe(303);
    expect(await listAccounts(tokens.access)).toEqual({ ok: false, status: 401 });
    const refresh = await token({ grant_type: "refresh_token", client_id: clientId, refresh_token: tokens.refresh });
    expect(refresh.body.error).toBe("invalid_grant");
  });

  it("keeps users isolated: tokens, codes and dashboard revokes", async () => {
    const clientId = (await register()).client_id as string;
    const otherClient = (await register({ client_name: "Other" })).client_id as string;
    const ada = new CookieJar();
    const bob = new CookieJar();
    const adaId = await signup(ada, "ada@example.com");
    const bobId = await signup(bob, "bob@example.com");
    addMailbox(adaId, "Ada Work", "ada@work.example");
    addMailbox(bobId, "Bob Work", "bob@work.example");
    const adaTokens = await fullGrant(ada, clientId);
    const bobTokens = await fullGrant(bob, clientId);
    expect(await listAccounts(adaTokens.access)).toEqual({ ok: true, names: ["Ada Work"] });
    expect(await listAccounts(bobTokens.access)).toEqual({ ok: true, names: ["Bob Work"] });

    // A code issued to one client cannot be redeemed by another.
    const { verifier, challenge } = pkce();
    const location = await consent(ada, standardParams(clientId, challenge));
    const stolen = await token({
      grant_type: "authorization_code",
      client_id: otherClient,
      code: location.searchParams.get("code") as string,
      redirect_uri: REDIRECT,
      code_verifier: verifier,
    });
    expect(stolen.body.error).toBe("invalid_grant");
    // A refresh token of one client cannot be used by another.
    const crossRefresh = await token({ grant_type: "refresh_token", client_id: otherClient, refresh_token: adaTokens.refresh });
    expect(crossRefresh.body.error).toBe("invalid_grant");
    // Another client's revoke request is ignored.
    await fetch(`${base}/oauth/revoke`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: otherClient, token: adaTokens.refresh }),
    });
    expect((await listAccounts(adaTokens.access)).ok).toBe(true);

    // Bob cannot disconnect Ada's app from his dashboard.
    const adaDash = await readHtml(await fetchJar(ada, `${base}/dashboard`));
    const adaGrant = adaDash.match(/action="\/apps\/([0-9a-f-]{36})\/revoke"/)![1];
    const bobDash = await readHtml(await fetchJar(bob, `${base}/dashboard`));
    const res = await fetchJar(bob, `${base}/apps/${adaGrant}/revoke`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ _csrf: csrfFromHtml(bobDash) }),
    });
    expect(res.status).toBe(404);
    expect((await listAccounts(adaTokens.access)).ok).toBe(true);
  });

  it("protects the consent form with CSRF, handles Deny, and refuses open redirects after login", async () => {
    const clientId = (await register()).client_id as string;
    const jar = new CookieJar();
    await signup(jar, "ada@example.com");
    const { challenge } = pkce();
    const params = standardParams(clientId, challenge);
    const forged = await fetchJar(jar, `${base}/oauth/authorize`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ ...params, decision: "allow", _csrf: "forged" }),
    });
    expect(forged.status).toBe(403);
    const noSession = await fetch(`${base}/oauth/authorize`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ ...params, decision: "allow" }),
      redirect: "manual",
    });
    expect(noSession.status).toBe(403);
    expect(db.prepare("SELECT COUNT(*) AS n FROM oauth_codes").get()).toEqual({ n: 0 });

    const denied = await consent(jar, params, "deny");
    expect(denied.searchParams.get("error")).toBe("access_denied");
    expect(denied.searchParams.get("code")).toBeNull();
    expect(denied.searchParams.get("iss")).toBe(base);

    // Logged-in GET /login?next=<external> goes to the dashboard instead.
    for (const evil of ["https://evil.example/", "//evil.example/x", "/oauth/authorize\\@evil.example", "/dashboard"]) {
      const res = await fetchJar(jar, `${base}/login?next=${encodeURIComponent(evil)}`);
      expect(res.status).toBe(303);
      expect(res.headers.get("location")).toBe("/dashboard");
    }
    // Login POST with an external next ends on the dashboard.
    const fresh = new CookieJar();
    const page = await fetchJar(fresh, `${base}/login`);
    const login = await fetchJar(fresh, `${base}/login`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ _csrf: csrfFromHtml(await readHtml(page)), email: "ada@example.com", password: PASSWORD, next: "https://evil.example/" }),
    });
    expect(login.headers.get("location")).toBe("/dashboard");
  });

  it("supports confidential DCR clients with a client secret", async () => {
    const reg = await register({ token_endpoint_auth_method: "client_secret_basic" });
    const clientId = reg.client_id as string;
    const secret = reg.client_secret as string;
    expect(secret).toMatch(/^oms_/);
    const jar = new CookieJar();
    await signup(jar, "ada@example.com");
    const { verifier, challenge } = pkce();
    const location = await consent(jar, standardParams(clientId, challenge));
    const form = {
      grant_type: "authorization_code",
      code: location.searchParams.get("code") as string,
      redirect_uri: REDIRECT,
      code_verifier: verifier,
    };
    const noSecret = await token({ ...form, client_id: clientId });
    expect(noSecret.status).toBe(401);
    expect(noSecret.body.error).toBe("invalid_client");
    const wrong = await token(form, { authorization: `Basic ${Buffer.from(`${clientId}:wrong`).toString("base64")}` });
    expect(wrong.status).toBe(401);
    const ok = await token(form, { authorization: `Basic ${Buffer.from(`${clientId}:${secret}`).toString("base64")}` });
    expect(ok.status).toBe(200);
  });

  it("supports Client ID Metadata Documents (CIMD) as public clients", async () => {
    const clientId = "https://app.example/oauth/client.json";
    cimdDocs.set(clientId, {
      status: 200,
      contentType: "application/json",
      maxAge: 600,
      body: JSON.stringify({
        client_id: clientId,
        client_name: "Example Agent",
        redirect_uris: ["http://localhost/callback", "http://127.0.0.1/callback"],
        token_endpoint_auth_methods_supported: ["none", "private_key_jwt"],
        token_endpoint_auth_method: "private_key_jwt",
      }),
    });
    const jar = new CookieJar();
    const userId = await signup(jar, "ada@example.com");
    addMailbox(userId, "Ada", "ada@work.example");
    const { verifier, challenge } = pkce();
    const redirect = "http://localhost:39123/callback";
    const params = standardParams(clientId, challenge, { redirect_uri: redirect });
    const page = await fetchJar(jar, authorizeUrl(params));
    expect(page.status).toBe(200);
    const html = await readHtml(page);
    expect(html).toContain("Example Agent");
    expect(html).toContain("published at <strong class=\"consent-url\">https://app.example/");
    expect(html).toContain("runs on your own computer");
    expect(page.headers.get("content-security-policy")).toContain("form-action 'self' http://localhost:39123");
    const location = await consent(jar, params);
    expect(location.origin).toBe("http://localhost:39123");
    expect(fetchCount).toBe(1); // second GET used the cache
    const exchanged = await token({
      grant_type: "authorization_code",
      client_id: clientId,
      code: location.searchParams.get("code") as string,
      redirect_uri: redirect,
      code_verifier: verifier,
      resource: config.issuer,
    });
    expect(exchanged.status).toBe(200);
    expect((await listAccounts(exchanged.body.access_token as string)).ok).toBe(true);
    // private_key_jwt assertions are refused (we only support none).
    const assertion = await token({ grant_type: "refresh_token", client_id: clientId, refresh_token: exchanged.body.refresh_token as string, client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer", client_assertion: "x" });
    expect(assertion.status).toBe(401);
  });

  it("rejects invalid CIMD documents", async () => {
    const jar = new CookieJar();
    await signup(jar, "ada@example.com");
    const { challenge } = pkce();
    const cases: Array<[string, Record<string, unknown> | string]> = [
      ["https://a.example/mismatch.json", { client_id: "https://other.example/x.json", redirect_uris: [REDIRECT] }],
      ["https://a.example/secret.json", { client_id: "https://a.example/secret.json", redirect_uris: [REDIRECT], client_secret: "x" }],
      ["https://a.example/jwt.json", { client_id: "https://a.example/jwt.json", redirect_uris: [REDIRECT], token_endpoint_auth_method: "private_key_jwt" }],
      ["https://a.example/badredirect.json", { client_id: "https://a.example/badredirect.json", redirect_uris: ["http://evil.example/cb"] }],
      ["https://a.example/notjson.json", "<html>"],
    ];
    for (const [id, doc] of cases) {
      cimdDocs.set(id, { status: 200, contentType: "application/json", body: typeof doc === "string" ? doc : JSON.stringify(doc) });
      const res = await fetchJar(jar, authorizeUrl(standardParams(id, challenge)));
      expect(res.status).toBe(400);
      expect(res.headers.get("location")).toBeNull();
    }
    const missing = await fetchJar(jar, authorizeUrl(standardParams("https://a.example/missing.json", challenge)));
    expect(missing.status).toBe(400);
    // Network failures all read the same, so the page is not a resolver oracle.
    const internal = await fetchJar(jar, authorizeUrl(standardParams("https://internal.example/c.json", challenge)));
    expect(internal.status).toBe(400);
    const internalHtml = await readHtml(internal);
    expect(internalHtml).not.toContain("public internet address");
    expect(internalHtml).toContain("could not be fetched");
  });

  it("keeps API keys working next to OAuth tokens", async () => {
    const jar = new CookieJar();
    const userId = await signup(jar, "ada@example.com");
    addMailbox(userId, "Ada", "ada@work.example");
    const key = apiKeys.create(db, { userId, name: "grok" }).token;
    expect(await listAccounts(key)).toEqual({ ok: true, names: ["Ada"] });
    const user = await users.verifyPassword(db, { email: "ada@example.com", password: PASSWORD });
    expect(user?.id).toBe(userId);
  });

  it("interoperates with the official MCP SDK OAuth client (discovery, DCR, PKCE, refresh)", async () => {
    const jar = new CookieJar();
    const userId = await signup(jar, "ada@example.com");
    addMailbox(userId, "Ada SDK", "ada@work.example");
    const redirectUrl = "http://localhost:6274/oauth/callback";
    let clientInfo: Record<string, unknown> | undefined;
    let saved: Record<string, unknown> | undefined;
    let verifier = "";
    let code = "";
    const provider: OAuthClientProvider = {
      get redirectUrl() {
        return redirectUrl;
      },
      get clientMetadata() {
        return {
          client_name: "SDK Test",
          redirect_uris: [redirectUrl],
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
          token_endpoint_auth_method: "none",
        };
      },
      clientInformation: () => clientInfo as never,
      saveClientInformation: (info) => {
        clientInfo = info as never;
      },
      tokens: () => saved as never,
      saveTokens: (tokens) => {
        saved = tokens as never;
      },
      redirectToAuthorization: async (url) => {
        const location = await consent(jar, Object.fromEntries(url.searchParams.entries()));
        code = location.searchParams.get("code") ?? "";
      },
      saveCodeVerifier: (v) => {
        verifier = v;
      },
      codeVerifier: () => verifier,
    };
    const serverUrl = new URL(`${base}/mcp`);
    const first = new StreamableHTTPClientTransport(serverUrl, { authProvider: provider });
    const client1 = new Client({ name: "sdk", version: "1" });
    await expect(client1.connect(first)).rejects.toBeInstanceOf(UnauthorizedError);
    expect(code).toMatch(/^omc_/);
    await first.finishAuth(code);
    expect(saved?.access_token).toMatch(/^oma_/);
    const client2 = new Client({ name: "sdk", version: "1" });
    await client2.connect(new StreamableHTTPClientTransport(serverUrl, { authProvider: provider }));
    const tools = await client2.listTools();
      expect(tools.tools.map((t) => t.name).sort()).toEqual([
        "list_accounts",
        "list_folders",
        "read_message",
        "read_thread",
        "search_messages",
        "send_message",
      ]);
    for (const tool of tools.tools) {
      if (tool.name === "send_message") {
        expect(tool.annotations).toMatchObject({
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: false,
          openWorldHint: true,
        });
      } else {
        expect(tool.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false, openWorldHint: false });
      }
      expect(tool.annotations?.title ?? tool.title).toBeTruthy();
    }
    await client2.close();
  });

  it("grants mail.send only when the consent box is ticked", async () => {
    const client = await register();
    const clientId = client.client_id as string;
    const jar = new CookieJar();
    const userId = await signup(jar, "send@example.com");
    addMailbox(userId, "Send Box", "send@work.example");
    const { verifier, challenge } = pkce();
    const params = standardParams(clientId, challenge, { scope: "mail.read mail.send" });
    const page = await fetchJar(jar, authorizeUrl(params));
    const html = await readHtml(page);
    expect(html).toContain("wants access to your OpenMail mailboxes");
    expect(html).toContain("Send email as you");
    expect(html).toContain("Also allow");
    expect(html).not.toContain('name="allow_send" type="checkbox" value="on" checked');

    const denied = await consent(jar, params);
    const without = await token({
      grant_type: "authorization_code",
      client_id: clientId,
      code: denied.searchParams.get("code") as string,
      redirect_uri: REDIRECT,
      code_verifier: verifier,
      resource: config.resource,
    });
    expect(without.body.scope).toBe("mail.read");

    const { verifier: verifier2, challenge: challenge2 } = pkce();
    const again = standardParams(clientId, challenge2, { scope: "mail.send" });
    const allowed = await consent(jar, again, "allow", { allow_send: "on" });
    const withSend = await token({
      grant_type: "authorization_code",
      client_id: clientId,
      code: allowed.searchParams.get("code") as string,
      redirect_uri: REDIRECT,
      code_verifier: verifier2,
      resource: config.resource,
    });
    expect(withSend.body.scope).toBe("mail.read mail.send");
    const principal = authenticateDatabaseKey(db, `Bearer ${withSend.body.access_token as string}`, config.resource);
    expect(principal?.canSend).toBe(true);
    expect(principal?.via.startsWith("oauth:")).toBe(true);
  });
});

function decodeEntities(value: string): string {
  return value.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}
