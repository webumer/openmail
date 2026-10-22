// Live end-to-end OAuth check against a deployed OpenMail.
// Usage: OPENMAIL_BASE=https://mcp.openmail.tools OPENMAIL_LOGIN_EMAIL=... OPENMAIL_LOGIN_PASSWORD_FILE=... node scripts/oauth-live-check.mjs
// Prints only pass/fail lines and non-secret facts. Never prints passwords or tokens.
import { readFileSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";

const BASE = process.env.OPENMAIL_BASE ?? "https://mcp.openmail.tools";
const EMAIL = process.env.OPENMAIL_LOGIN_EMAIL;
const PASSWORD = readFileSync(process.env.OPENMAIL_LOGIN_PASSWORD_FILE, "utf8").trim();
const API_KEY_FILE = process.env.OPENMAIL_API_KEY_FILE;
const MCP = `${BASE}/mcp`;
let failures = 0;
const check = (name, ok, extra = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? `  (${extra})` : ""}`);
  if (!ok) failures += 1;
};

class Jar {
  m = new Map();
  store(res) {
    for (const line of res.headers.getSetCookie?.() ?? []) {
      const [pair] = line.split(";");
      const i = pair.indexOf("=");
      const k = pair.slice(0, i).trim();
      const v = pair.slice(i + 1).trim();
      if (v) this.m.set(k, v);
      else this.m.delete(k);
    }
  }
  header() {
    return [...this.m].map(([k, v]) => `${k}=${v}`).join("; ");
  }
}
const jar = new Jar();
async function jfetch(url, init = {}) {
  const headers = new Headers(init.headers);
  if (jar.m.size) headers.set("cookie", jar.header());
  const res = await fetch(url, { ...init, headers, redirect: "manual" });
  jar.store(res);
  return res;
}
const csrfOf = (html) => html.match(/name="_csrf" value="([^"]+)"/)?.[1];
const decode = (v) => v.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

/** Browser part: authorize → (login) → consent → Allow. Returns the callback URL. */
async function browserAuthorize(authorizeUrl, label) {
  let res = await jfetch(authorizeUrl);
  if (res.status === 303 && (res.headers.get("location") ?? "").startsWith("/login")) {
    const loginUrl = new URL(res.headers.get("location"), BASE);
    const page = await jfetch(loginUrl);
    const html = await page.text();
    const next = loginUrl.searchParams.get("next");
    const login = await jfetch(`${BASE}/login`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ _csrf: csrfOf(html), email: EMAIL, password: PASSWORD, next }),
    });
    check(`${label}: login redirects back to authorize`, login.status === 303 && login.headers.get("location") === next);
    res = await jfetch(new URL(next, BASE));
  }
  check(`${label}: consent page shown`, res.status === 200, `status ${res.status}`);
  const csp = res.headers.get("content-security-policy") ?? "";
  check(`${label}: consent CSP frame-ancestors none + callback form-action`, csp.includes("frame-ancestors 'none'") && /form-action 'self' \S+/.test(csp));
  const html = await res.text();
  check(`${label}: consent text`, html.includes("wants read-only access to your OpenMail mailboxes") || (html.includes("wants access to your OpenMail mailboxes") && /<form[^>]*action="\/oauth\/authorize"[\s\S]*name="allow_send"(?![^>]*checked)[\s\S]*<\/form>/.test(html)));
  const form = new URLSearchParams();
  for (const m of html.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g)) form.set(m[1], decode(m[2]));
  form.set("decision", "allow");
  const post = await jfetch(`${BASE}/oauth/authorize`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form,
  });
  const refresh = post.headers.get("refresh") ?? "";
  const loc = new URL(refresh.replace(/^0; url=/, ""));
  check(`${label}: return page carries code, state and iss`, post.status === 200 && !post.headers.get("location") && !!loc.searchParams.get("code") && loc.searchParams.get("iss") === BASE);
  return loc;
}

async function token(form) {
  const res = await fetch(`${BASE}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(form),
  });
  return { status: res.status, body: await res.json() };
}

async function withBearer(bearer, fn) {
  const client = new Client({ name: "openmail-live-check", version: "1" });
  await client.connect(new StreamableHTTPClientTransport(new URL(MCP), { requestInit: { headers: { authorization: `Bearer ${bearer}` } } }));
  try {
    return await fn(client);
  } finally {
    await client.close();
  }
}
const data = (r) => r.structuredContent?.data;
async function mcpStatus(bearer) {
  const res = await fetch(MCP, {
    method: "POST",
    headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  return res.status;
}

// 1. Discovery
const prm = await (await fetch(`${BASE}/.well-known/oauth-protected-resource/mcp`)).json();
check("PRM resource + authorization_servers", prm.resource === MCP && prm.authorization_servers?.[0] === BASE);
const asm = await (await fetch(`${BASE}/.well-known/oauth-authorization-server`)).json();
check("ASM issuer, S256, CIMD, iss, none", asm.issuer === BASE && asm.code_challenge_methods_supported?.includes("S256") && asm.client_id_metadata_document_supported === true && asm.authorization_response_iss_parameter_supported === true && asm.token_endpoint_auth_methods_supported?.includes("none"));
const unauth = await fetch(MCP, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
const www = unauth.headers.get("www-authenticate") ?? "";
check("/mcp 401 with resource_metadata + scope", unauth.status === 401 && www.includes(`resource_metadata="${BASE}/.well-known/oauth-protected-resource/mcp"`) && /scope="mail\.read( mail\.send)?"/.test(www));

// 2. SDK client: discovery → DCR → PKCE authorize → token → tools
const redirectUrl = "http://localhost:6274/oauth/callback";
let info, saved, verifier, callback;
const provider = {
  get redirectUrl() { return redirectUrl; },
  get clientMetadata() {
    return { client_name: "OpenMail live check (MCP SDK)", redirect_uris: [redirectUrl], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none" };
  },
  clientInformation: () => info,
  saveClientInformation: (i) => { info = i; },
  tokens: () => saved,
  saveTokens: (t) => { saved = t; },
  redirectToAuthorization: async (url) => {
    check("SDK authorize URL has PKCE S256 + resource", url.searchParams.get("code_challenge_method") === "S256" && url.searchParams.get("resource") === MCP);
    callback = await browserAuthorize(url, "SDK/DCR");
  },
  saveCodeVerifier: (v) => { verifier = v; },
  codeVerifier: () => verifier,
};
const t1 = new StreamableHTTPClientTransport(new URL(MCP), { authProvider: provider });
try {
  await new Client({ name: "x", version: "1" }).connect(t1);
  check("SDK: first connect requires auth", false);
} catch (err) {
  check("SDK: first connect requires auth", err instanceof UnauthorizedError);
}
check("SDK: DCR client registered", typeof info?.client_id === "string" && info.client_id.startsWith("omcl_"));
await t1.finishAuth(callback.searchParams.get("code"));
check("SDK: token exchange", typeof saved?.access_token === "string" && saved.access_token.startsWith("oma_") && saved.expires_in === 3600);
const sdkClient = new Client({ name: "openmail-live-check", version: "1" });
await sdkClient.connect(new StreamableHTTPClientTransport(new URL(MCP), { authProvider: provider }));
const tools = await sdkClient.listTools();
check("tools/list returns 6 tools", tools.tools.length === 6, tools.tools.map((t) => t.name).join(","));
const readTools = tools.tools.filter((t) => t.name !== "send_message");
const sendTool = tools.tools.find((t) => t.name === "send_message");
check("read tools readOnly/!destructive/!openWorld + title", readTools.length === 5 && readTools.every((t) => t.annotations?.readOnlyHint === true && t.annotations?.destructiveHint === false && t.annotations?.openWorldHint === false && (t.title || t.annotations?.title)));
check("send_message !readOnly/destructive/openWorld + title", !!sendTool && sendTool.annotations?.readOnlyHint === false && sendTool.annotations?.destructiveHint === true && sendTool.annotations?.openWorldHint === true && !!(sendTool.title || sendTool.annotations?.title));
const accounts = data(await sdkClient.callTool({ name: "list_accounts", arguments: {} })) ?? [];
const demo = accounts.find((a) => /demo/i.test(`${a.label} ${a.email}`)) ?? accounts[0];
check("list_accounts shows the Demo mailbox", !!demo, demo ? `${demo.id} ${demo.email}` : "none");
const search = data(await sdkClient.callTool({ name: "search_messages", arguments: { account: demo.id, folder: "INBOX", limit: 10 } }));
const messages = search?.messages ?? [];
check("search_messages on Demo INBOX", messages.length > 0, `${messages.length} messages`);
const unreadBefore = data(await sdkClient.callTool({ name: "search_messages", arguments: { account: demo.id, folder: "INBOX", unread: true, limit: 50 } }))?.messages ?? [];
const target = unreadBefore[0] ?? messages[0];
const read = await sdkClient.callTool({ name: "read_message", arguments: { account: demo.id, folder: "INBOX", uid: target.uid } });
check("read_message works", !read.isError, `uid ${target.uid}`);
const unreadAfter = data(await sdkClient.callTool({ name: "search_messages", arguments: { account: demo.id, folder: "INBOX", unread: true, limit: 50 } }))?.messages ?? [];
if (unreadBefore.length > 0) {
  check("message still unread after read_message (no \\Seen)", unreadAfter.some((m) => m.uid === target.uid), `unread before ${unreadBefore.length}, after ${unreadAfter.length}`);
} else {
  check("unread count unchanged", unreadAfter.length === 0, "no unread messages in demo inbox");
}
await sdkClient.close();

// 3. Refresh rotation and reuse detection
const oldRefresh = saved.refresh_token;
const r1 = await token({ grant_type: "refresh_token", client_id: info.client_id, refresh_token: oldRefresh, resource: MCP });
check("refresh issues new tokens", r1.status === 200 && r1.body.refresh_token !== oldRefresh);
check("new access token works", (await mcpStatus(r1.body.access_token)) === 200);
check("old access token retired by the refresh", (await mcpStatus(saved.access_token)) === 401);

// 4. Revoke (RFC 7009) kills the connection
const rv = await fetch(`${BASE}/oauth/revoke`, {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ client_id: info.client_id, token: r1.body.refresh_token }),
});
check("revoke returns 200", rv.status === 200);
check("access token rejected after revoke", (await mcpStatus(r1.body.access_token)) === 401);
const afterRevoke = await token({ grant_type: "refresh_token", client_id: info.client_id, refresh_token: r1.body.refresh_token });
check("refresh rejected after revoke", afterRevoke.body.error === "invalid_grant");

// 5. Refresh reuse detection on a fresh grant (CIMD, Claude Code's real metadata document)
async function cimdFlow(clientId, redirectUri, label) {
  const v = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(v).digest("base64url");
  const url = new URL(`${BASE}/oauth/authorize`);
  url.search = new URLSearchParams({ response_type: "code", client_id: clientId, redirect_uri: redirectUri, code_challenge: challenge, code_challenge_method: "S256", state: "live-state", scope: "mail.read", resource: MCP }).toString();
  const cb = await browserAuthorize(url, label);
  check(`${label}: callback to ${new URL(redirectUri).host}`, cb.origin === new URL(redirectUri).origin && cb.searchParams.get("state") === "live-state");
  const form = { grant_type: "authorization_code", client_id: clientId, code: cb.searchParams.get("code"), redirect_uri: redirectUri, code_verifier: v, resource: MCP };
  const t = await token(form);
  check(`${label}: public-client token exchange`, t.status === 200, t.body.error ?? "");
  const again = await token(form);
  check(`${label}: code reuse rejected`, again.body.error === "invalid_grant");
  check(`${label}: tokens from a reused code are revoked`, (await mcpStatus(t.body.access_token)) === 401);
  return t;
}
const claudeCode = await (await fetch("https://claude.ai/oauth/claude-code-client-metadata")).json().catch(() => null);
if (claudeCode?.client_id) {
  await cimdFlow(claudeCode.client_id, "http://localhost:53682/callback", "CIMD/Claude Code");
} else {
  check("CIMD/Claude Code metadata reachable", false);
}
const chatgpt = await (await fetch("https://chatgpt.com/oauth/client.json")).json().catch(() => null);
if (chatgpt?.client_id && Array.isArray(chatgpt.redirect_uris)) {
  const t = await cimdFlowRefresh(chatgpt.client_id, chatgpt.redirect_uris[0], "CIMD/ChatGPT");
  void t;
} else {
  console.log("SKIP  CIMD/ChatGPT metadata not reachable from here");
}
async function cimdFlowRefresh(clientId, redirectUri, label) {
  const v = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(v).digest("base64url");
  const url = new URL(`${BASE}/oauth/authorize`);
  url.search = new URLSearchParams({ response_type: "code", client_id: clientId, redirect_uri: redirectUri, code_challenge: challenge, code_challenge_method: "S256", state: "s2", resource: MCP }).toString();
  const cb = await browserAuthorize(url, label);
  const t = await token({ grant_type: "authorization_code", client_id: clientId, code: cb.searchParams.get("code"), redirect_uri: redirectUri, code_verifier: v, resource: MCP });
  check(`${label}: token exchange`, t.status === 200, t.body.error ?? "");
  const r = await token({ grant_type: "refresh_token", client_id: clientId, refresh_token: t.body.refresh_token });
  check(`${label}: refresh`, r.status === 200);
  const reuse = await token({ grant_type: "refresh_token", client_id: clientId, refresh_token: t.body.refresh_token });
  check(`${label}: refresh reuse rejected`, reuse.body.error === "invalid_grant");
  check(`${label}: reuse revoked the whole connection`, (await mcpStatus(r.body.access_token)) === 401);
}

// 6. Negative checks
const wrongRedirect = await jfetch(`${BASE}/oauth/authorize?` + new URLSearchParams({ response_type: "code", client_id: info.client_id, redirect_uri: "https://evil.example/cb", code_challenge: "a".repeat(43), code_challenge_method: "S256" }));
check("unregistered redirect_uri is not followed", wrongRedirect.status === 400 && !wrongRedirect.headers.get("location"));
const nextEvil = await jfetch(`${BASE}/login?next=${encodeURIComponent("https://evil.example/")}`);
check("login next cannot open-redirect", nextEvil.status === 303 && nextEvil.headers.get("location") === "/dashboard");

// 7. Existing API key (Grok Bot connector) still works
if (API_KEY_FILE) {
  const key = readFileSync(API_KEY_FILE, "utf8").trim();
  const ids = await withBearer(key, async (c) => (data(await c.callTool({ name: "list_accounts", arguments: {} })) ?? []).map((a) => a.label ?? a.name));
  check("API key: list_accounts includes ttt-umer", ids.includes("ttt-umer"), `${ids.length} account(s)`);
}

console.log(failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
