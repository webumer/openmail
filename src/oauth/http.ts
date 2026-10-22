import type { IncomingMessage, ServerResponse } from "node:http";
import type Database from "better-sqlite3";
import { SlidingWindowRateLimit } from "../server/rate-limit.js";
import { mailAccounts } from "../services/index.js";
import { SESSION_COOKIE, readCookies } from "../web/cookies.js";
import { CONTENT_SECURITY_POLICY, overrideContentSecurityPolicy } from "../web/headers.js";
import { consentPage, oauthErrorPage, returnToClientPage, statusPage } from "../web/pages.js";
import { clientAddress, readBody, requestUrl } from "../web/request.js";
import { readSession, safeEqual } from "../web/session.js";
import {
  OAuthError,
  getStoredClient,
  isCimdClientId,
  registerClient,
  resolveCimdClient,
  verifyClientSecret,
  type OAuthClient,
} from "./clients.js";
import { CimdFetchError, type DocumentFetcher } from "./cimd-fetch.js";
import { MAIL_READ_SCOPE, MAIL_SEND_SCOPE, SUPPORTED_SCOPES, isOurResource, parseScope, type OAuthConfig } from "./config.js";
import { createAuthorizationCode, redeemAuthorizationCode, refreshGrant, revokeToken, type IssuedTokens } from "./grants.js";
import { isLoopbackRedirect, parseRedirectUri, redirectUriAllowed } from "./redirect-uri.js";
import { isValidCodeChallenge } from "./tokens.js";

export interface OAuthHandlerOptions {
  db: Database;
  config: OAuthConfig;
  fetcher: DocumentFetcher;
  trustProxy: boolean;
  bodyLimit?: number;
  /** DCR registrations per client address. Default 20 per hour. */
  registerRateLimit?: { limit: number; windowMs: number };
  /** Token + revoke requests per client address. Default 120 per minute. */
  tokenRateLimit?: { limit: number; windowMs: number };
  /** Authorize requests per client address. Default 60 per minute. */
  authorizeRateLimit?: { limit: number; windowMs: number };
  /** OpenAI domain verification token served at /.well-known/openai-apps-challenge. */
  openaiChallenge?: string;
}

const PRM_PATHS = new Set(["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"]);
const ASM_PATH = "/.well-known/oauth-authorization-server";
const CHALLENGE_PATH = "/.well-known/openai-apps-challenge";
const API_PATHS = new Set(["/oauth/register", "/oauth/token", "/oauth/revoke"]);
const AUTHORIZE_PATH = "/oauth/authorize";
const JSON_BODY_LIMIT = 16 * 1024;
const FORM_BODY_LIMIT = 16 * 1024;
const MAX_STATE_LENGTH = 1000;

const AUTHORIZE_PARAMS = [
  "response_type",
  "client_id",
  "redirect_uri",
  "state",
  "scope",
  "code_challenge",
  "code_challenge_method",
  "resource",
] as const;
type AuthorizeParams = Partial<Record<(typeof AUTHORIZE_PARAMS)[number], string>>;

export function isOAuthPath(pathname: string): boolean {
  return (
    PRM_PATHS.has(pathname) ||
    pathname === ASM_PATH ||
    pathname === CHALLENGE_PATH ||
    API_PATHS.has(pathname) ||
    pathname === AUTHORIZE_PATH
  );
}

export function authorizationServerMetadata(config: OAuthConfig): Record<string, unknown> {
  const base = config.issuer;
  return {
    issuer: base,
    authorization_endpoint: `${base}/oauth/authorize`,
    token_endpoint: `${base}/oauth/token`,
    registration_endpoint: `${base}/oauth/register`,
    revocation_endpoint: `${base}/oauth/revoke`,
    scopes_supported: [...SUPPORTED_SCOPES],
    response_types_supported: ["code"],
    response_modes_supported: ["query"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    token_endpoint_auth_methods_supported: ["none", "client_secret_post", "client_secret_basic"],
    revocation_endpoint_auth_methods_supported: ["none", "client_secret_post", "client_secret_basic"],
    code_challenge_methods_supported: ["S256"],
    client_id_metadata_document_supported: true,
    authorization_response_iss_parameter_supported: true,
    service_documentation: `${base}/reviewers`,
    op_policy_uri: `${base}/privacy`,
    op_tos_uri: `${base}/terms`,
  };
}

export function protectedResourceMetadata(config: OAuthConfig): Record<string, unknown> {
  return {
    resource: config.resource,
    authorization_servers: [config.issuer],
    scopes_supported: [...SUPPORTED_SCOPES],
    bearer_methods_supported: ["header"],
    resource_name: "OpenMail",
    resource_documentation: `${config.issuer}/reviewers`,
    resource_policy_uri: `${config.issuer}/privacy`,
    resource_tos_uri: `${config.issuer}/terms`,
  };
}

/** WWW-Authenticate for 401s on /mcp (RFC 6750 + RFC 9728). */
export function bearerChallenge(config: OAuthConfig, invalidToken: boolean): string {
  const parts = [
    'Bearer realm="openmail"',
    `resource_metadata="${config.resourceMetadataUrl}"`,
    `scope="${SUPPORTED_SCOPES.join(" ")}"`,
  ];
  if (invalidToken) parts.push('error="invalid_token"', 'error_description="The access token is invalid or expired"');
  return parts.join(", ");
}

export function createOAuthHandler(options: OAuthHandlerOptions): (req: IncomingMessage, res: ServerResponse) => Promise<boolean> {
  const registerLimit = new SlidingWindowRateLimit(
    options.registerRateLimit?.limit ?? 20,
    options.registerRateLimit?.windowMs ?? 60 * 60 * 1000,
  );
  const tokenLimit = new SlidingWindowRateLimit(
    options.tokenRateLimit?.limit ?? 120,
    options.tokenRateLimit?.windowMs ?? 60_000,
  );
  const authorizeLimit = new SlidingWindowRateLimit(
    options.authorizeRateLimit?.limit ?? 60,
    options.authorizeRateLimit?.windowMs ?? 60_000,
  );
  // Uncached metadata-document fetches: per host, and overall, so the
  // authorize endpoint cannot be used to make the server fetch URLs in bulk.
  const fetchHostLimit = new SlidingWindowRateLimit(10, 60_000);
  const fetchGlobalLimit = new SlidingWindowRateLimit(120, 60_000);
  // A cache-bypassing refetch (unknown redirect_uri) at most once a minute per client.
  const forceRefreshLimit = new SlidingWindowRateLimit(1, 60_000);
  const fetcher: DocumentFetcher = async (target) => {
    if (!fetchGlobalLimit.allow("cimd") || !fetchHostLimit.allow(`cimd:${target.hostname}`)) {
      throw new CimdFetchError("too many client metadata requests; try again in a minute");
    }
    return options.fetcher(target);
  };
  const ctx: Ctx = { ...options, fetcher, registerLimit, tokenLimit, authorizeLimit, forceRefreshLimit };
  return async (req, res) => {
    const url = requestUrl(req);
    if (!isOAuthPath(url.pathname)) return false;
    try {
      await route(req, res, url, ctx);
    } catch (err) {
      if (res.headersSent || res.writableEnded) return true;
      if (url.pathname === AUTHORIZE_PATH) {
        writeHtml(res, 500, statusPage("Something went wrong", "The request could not be completed."));
      } else {
        writeOAuthError(res, new OAuthError("server_error", "The request could not be completed", 500));
      }
      void err;
    }
    return true;
  };
}

interface Ctx extends OAuthHandlerOptions {
  registerLimit: SlidingWindowRateLimit;
  tokenLimit: SlidingWindowRateLimit;
  authorizeLimit: SlidingWindowRateLimit;
  forceRefreshLimit: SlidingWindowRateLimit;
}

async function route(req: IncomingMessage, res: ServerResponse, url: URL, ctx: Ctx): Promise<void> {
  const path = url.pathname;
  const method = req.method ?? "GET";
  const isApi = API_PATHS.has(path) || PRM_PATHS.has(path) || path === ASM_PATH;
  if (isApi && method === "OPTIONS") {
    req.resume();
    res.writeHead(204, { ...corsHeaders(), "content-length": 0 });
    res.end();
    return;
  }
  if (PRM_PATHS.has(path) || path === ASM_PATH) {
    if (method !== "GET" && method !== "HEAD") return methodNotAllowed(req, res, "GET, HEAD, OPTIONS");
    req.resume();
    const body = PRM_PATHS.has(path) ? protectedResourceMetadata(ctx.config) : authorizationServerMetadata(ctx.config);
    writeJson(res, 200, body, { "cache-control": "public, max-age=300", ...corsHeaders() }, method === "HEAD");
    return;
  }
  if (path === CHALLENGE_PATH) {
    req.resume();
    if (method !== "GET" && method !== "HEAD") return methodNotAllowed(req, res, "GET, HEAD");
    const token = ctx.openaiChallenge?.trim();
    if (!token) {
      writeJson(res, 404, { ok: false, error: { code: "not_found", message: "Not found" } });
      return;
    }
    const payload = Buffer.from(token, "utf8");
    res.writeHead(200, { "content-type": "text/plain; charset=utf-8", "content-length": payload.length, "cache-control": "no-store" });
    res.end(method === "HEAD" ? undefined : payload);
    return;
  }
  if (path === "/oauth/register") {
    if (method !== "POST") return methodNotAllowed(req, res, "POST, OPTIONS", true);
    return handleRegister(req, res, ctx);
  }
  if (path === "/oauth/token") {
    if (method !== "POST") return methodNotAllowed(req, res, "POST, OPTIONS", true);
    return handleToken(req, res, ctx);
  }
  if (path === "/oauth/revoke") {
    if (method !== "POST") return methodNotAllowed(req, res, "POST, OPTIONS", true);
    return handleRevoke(req, res, ctx);
  }
  if (path === AUTHORIZE_PATH) {
    if (method === "GET") return handleAuthorizeGet(req, res, url, ctx);
    if (method === "POST") return handleAuthorizePost(req, res, ctx);
    return methodNotAllowed(req, res, "GET, POST");
  }
}

// ---------- registration ----------

async function handleRegister(req: IncomingMessage, res: ServerResponse, ctx: Ctx): Promise<void> {
  const ip = clientAddress(req, ctx.trustProxy);
  if (!ctx.registerLimit.allow(`register:${ip}`)) {
    req.resume();
    writeOAuthError(res, new OAuthError("slow_down", "Too many registrations; try again later", 429), { "retry-after": "3600" });
    return;
  }
  if (contentType(req) !== "application/json") {
    req.resume();
    writeOAuthError(res, new OAuthError("invalid_client_metadata", "Content-Type must be application/json"));
    return;
  }
  const body = await readBody(req, Math.min(ctx.bodyLimit ?? JSON_BODY_LIMIT, JSON_BODY_LIMIT));
  if (!body.ok) {
    writeOAuthError(res, new OAuthError("invalid_client_metadata", "Registration body is too large or unreadable"));
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.body.toString("utf8"));
  } catch {
    writeOAuthError(res, new OAuthError("invalid_client_metadata", "Registration body is not valid JSON"));
    return;
  }
  try {
    const result = registerClient(ctx.db, parsed);
    const c = result.client;
    writeJson(
      res,
      201,
      {
        client_id: c.id,
        client_id_issued_at: result.issuedAt,
        ...(result.clientSecret ? { client_secret: result.clientSecret, client_secret_expires_at: 0 } : {}),
        client_name: c.clientName,
        redirect_uris: c.redirectUris,
        grant_types: result.grantTypes,
        response_types: result.responseTypes,
        token_endpoint_auth_method: c.tokenEndpointAuthMethod,
        scope: SUPPORTED_SCOPES.join(" "),
        ...(c.clientUri ? { client_uri: c.clientUri } : {}),
      },
      { ...corsHeaders(), pragma: "no-cache" },
    );
  } catch (err) {
    if (err instanceof OAuthError) {
      writeOAuthError(res, err);
      return;
    }
    throw err;
  }
}

// ---------- authorize ----------

type Validated =
  | { kind: "page"; status: number; title: string; text: string }
  | { kind: "redirect"; redirectUri: string; error: string; description: string; state?: string }
  | {
      kind: "ok";
      client: OAuthClient;
      redirectUri: string;
      state?: string;
      scope: string;
      codeChallenge: string;
      resource: string;
      normalized: Record<string, string>;
    };

async function validateAuthorize(params: AuthorizeParams, duplicate: boolean, ctx: Ctx): Promise<Validated> {
  const clientId = params.client_id;
  if (!clientId) return { kind: "page", status: 400, title: "Missing app details", text: "The request did not say which app is connecting (client_id)." };
  let client: OAuthClient | null;
  try {
    client = isCimdClientId(clientId) ? await resolveCimdClient(ctx.db, clientId, ctx.fetcher) : getStoredClient(ctx.db, clientId);
  } catch (err) {
    const detail = err instanceof OAuthError ? err.description : "The app could not be identified.";
    return { kind: "page", status: 400, title: "Unknown app", text: `This app could not be verified: ${detail}.` };
  }
  if (!client) return { kind: "page", status: 400, title: "Unknown app", text: "This app is not registered with OpenMail." };
  const redirectUri = params.redirect_uri;
  // A CIMD client may have published a new redirect URI since we cached its
  // document: fetch it once more before refusing. Limited to one refetch per
  // client per minute (plus the per-host and global fetch limits).
  if (
    client.kind === "cimd" &&
    redirectUri &&
    !redirectUriAllowed(client.redirectUris, redirectUri) &&
    ctx.forceRefreshLimit.allow(`refresh:${clientId}`)
  ) {
    try {
      client = await resolveCimdClient(ctx.db, clientId, ctx.fetcher, Date.now(), { forceRefresh: true });
    } catch {
      // Keep the cached document; the check below refuses the redirect.
    }
  }
  if (!redirectUri || !redirectUriAllowed(client.redirectUris, redirectUri)) {
    return {
      kind: "page",
      status: 400,
      title: "Invalid redirect",
      text: "The address this app wants to return to is not one it registered, so OpenMail will not send you there.",
    };
  }
  const state = params.state;
  const fail = (error: string, description: string): Validated => ({
    kind: "redirect",
    redirectUri,
    error,
    description,
    ...(state !== undefined && state.length <= MAX_STATE_LENGTH ? { state } : {}),
  });
  if (duplicate) return fail("invalid_request", "Parameters must not be repeated");
  if (state !== undefined && state.length > MAX_STATE_LENGTH) return fail("invalid_request", "state is too long");
  if (params.response_type !== "code") return fail("unsupported_response_type", "Only response_type=code is supported");
  if (!params.code_challenge || !isValidCodeChallenge(params.code_challenge)) {
    return fail("invalid_request", "PKCE is required: send a code_challenge (S256)");
  }
  if (params.code_challenge_method !== "S256") return fail("invalid_request", "code_challenge_method must be S256");
  const scope = parseScope(params.scope);
  if (!scope.ok) return fail("invalid_scope", `Supported scopes: ${SUPPORTED_SCOPES.join(" ")}`);
  if (params.resource !== undefined && !isOurResource(ctx.config, params.resource)) {
    return fail("invalid_target", `resource must be ${ctx.config.resource}`);
  }
  const normalized: Record<string, string> = {
    response_type: "code",
    client_id: client.id,
    redirect_uri: redirectUri,
    scope: scope.scope,
    code_challenge: params.code_challenge,
    code_challenge_method: "S256",
    resource: ctx.config.resource,
  };
  if (state !== undefined) normalized.state = state;
  return {
    kind: "ok",
    client,
    redirectUri,
    ...(state !== undefined ? { state } : {}),
    scope: scope.scope,
    codeChallenge: params.code_challenge,
    resource: ctx.config.resource,
    normalized,
  };
}

function readAuthorizeParams(search: URLSearchParams): { params: AuthorizeParams; duplicate: boolean } {
  const params: AuthorizeParams = {};
  let duplicate = false;
  for (const name of AUTHORIZE_PARAMS) {
    const values = search.getAll(name);
    if (values.length > 1) duplicate = true;
    if (values.length > 0) params[name] = values[0] as string;
  }
  return { params, duplicate };
}

async function handleAuthorizeGet(req: IncomingMessage, res: ServerResponse, url: URL, ctx: Ctx): Promise<void> {
  req.resume();
  const ip = clientAddress(req, ctx.trustProxy);
  if (!ctx.authorizeLimit.allow(`authorize:${ip}`)) {
    writeHtml(res, 429, statusPage("Too many attempts", "Try again in a minute."), { "retry-after": "60" });
    return;
  }
  const { params, duplicate } = readAuthorizeParams(url.searchParams);
  const checked = await validateAuthorize(params, duplicate, ctx);
  if (checked.kind === "page") {
    writeHtml(res, checked.status, oauthErrorPage(checked.title, checked.text));
    return;
  }
  if (checked.kind === "redirect") {
    redirectToClient(res, checked.redirectUri, ctx.config, { error: checked.error, error_description: checked.description, state: checked.state });
    return;
  }
  const session = readSession(ctx.db, readCookies(cookieHeader(req)).get(SESSION_COOKIE));
  if (!session) {
    const next = `${AUTHORIZE_PATH}?${new URLSearchParams(checked.normalized).toString()}`;
    if (next.length > 4096) {
      writeHtml(res, 400, oauthErrorPage("Request too long", "The sign-in request from this app is too long."));
      return;
    }
    res.writeHead(303, { location: `/login?next=${encodeURIComponent(next)}`, "content-length": 0, "cache-control": "no-store" });
    res.end();
    return;
  }
  renderConsent(res, ctx, session, checked);
}

function renderConsent(
  res: ServerResponse,
  ctx: Ctx,
  session: { userId: string; email: string; csrfSecret: string },
  checked: Extract<Validated, { kind: "ok" }>,
): void {
  const redirect = parseRedirectUri(checked.redirectUri) as URL;
  // Warn based on where this request returns, not the whole registered list.
  const loopback = isLoopbackRedirect(redirect);
  const clientUrl = checked.client.kind === "cimd" ? checked.client.id : "";
  // The consent form posts here and is then redirected to the client's
  // callback. Browsers apply form-action to that redirect target.
  overrideContentSecurityPolicy(
    res,
    CONTENT_SECURITY_POLICY.replace("form-action 'self'", `form-action 'self' ${redirect.origin}`),
  );
  writeHtml(
    res,
    200,
    consentPage({
      csrf: session.csrfSecret,
      email: session.email,
      clientName: checked.client.clientName,
      clientKind: checked.client.kind,
      clientUrl,
      redirectUri: checked.redirectUri,
      redirectHost: redirect.host,
      loopback,
      accounts: mailAccounts.list(ctx.db, session.userId),
      params: checked.normalized,
      sendRequested: checked.scope.split(" ").includes(MAIL_SEND_SCOPE),
    }),
  );
}

async function handleAuthorizePost(req: IncomingMessage, res: ServerResponse, ctx: Ctx): Promise<void> {
  const session = readSession(ctx.db, readCookies(cookieHeader(req)).get(SESSION_COOKIE));
  if (contentType(req) !== "application/x-www-form-urlencoded") {
    req.resume();
    writeHtml(res, 415, statusPage("Unsupported media type", "Submit the form from this site."));
    return;
  }
  const body = await readBody(req, FORM_BODY_LIMIT);
  if (!body.ok) {
    writeHtml(res, body.status, statusPage("Bad request", body.message));
    return;
  }
  const form = new URLSearchParams(body.body.toString("utf8"));
  const csrf = form.get("_csrf") ?? "";
  if (!session || !csrf || !safeEqual(session.csrfSecret, csrf)) {
    writeHtml(res, 403, statusPage("Forbidden", "The form expired or the request was rejected. Start the connection again from the app."));
    return;
  }
  if (!ctx.authorizeLimit.allow(`authorize-post:${session.userId}`)) {
    writeHtml(res, 429, statusPage("Too many attempts", "Try again in a minute."), { "retry-after": "60" });
    return;
  }
  const { params, duplicate } = readAuthorizeParams(form);
  const checked = await validateAuthorize(params, duplicate, ctx);
  if (checked.kind === "page") {
    writeHtml(res, checked.status, oauthErrorPage(checked.title, checked.text));
    return;
  }
  if (checked.kind === "redirect") {
    returnToClient(res, checked.redirectUri, ctx.config, { error: checked.error, error_description: checked.description, state: checked.state });
    return;
  }
  const decision = form.getAll("decision");
  if (decision.length !== 1 || decision[0] !== "allow") {
    returnToClient(res, checked.redirectUri, ctx.config, {
      error: "access_denied",
      error_description: "The user denied access",
      state: checked.state,
    });
    return;
  }
  const code = createAuthorizationCode(ctx.db, {
    client: checked.client,
    userId: session.userId,
    redirectUri: checked.redirectUri,
    codeChallenge: checked.codeChallenge,
    scope: grantedScope(checked.scope, form.get("allow_send")),
    resource: checked.resource,
  });
  returnToClient(res, checked.redirectUri, ctx.config, { code, state: checked.state });
}

/**
 * After the consent form is posted, return to the client with a 200 page that
 * navigates by Refresh header and meta refresh instead of a 303. Browsers
 * apply CSP form-action to every hop of a form submission's redirect chain,
 * and some clients relay their callback onward (ChatGPT's
 * connector_platform_oauth_redirect forwards to platform.openai.com), so a
 * 303 would be blocked even though the callback origin is allowed. A refresh
 * is a new navigation, so the consent page keeps form-action 'self'.
 */
function returnToClient(
  res: ServerResponse,
  redirectUri: string,
  config: OAuthConfig,
  params: Record<string, string | undefined>,
): void {
  const target = new URL(redirectUri);
  for (const [name, value] of Object.entries(params)) {
    if (value !== undefined) target.searchParams.set(name, value);
  }
  target.searchParams.set("iss", config.issuer);
  const href = target.toString().replace(/'/g, "%27");
  writeHtml(res, 200, returnToClientPage(href), { refresh: `0; url=${href}` });
}

/** mail.send is granted only when it was requested and the user ticked the box. */
function grantedScope(requested: string, allowSend: string | null): string {
  const parts = requested.split(" ").filter((part) => part.length > 0);
  const send = parts.includes(MAIL_SEND_SCOPE) && allowSend === "on";
  const kept = parts.filter((part) => part !== MAIL_SEND_SCOPE || send);
  if (!kept.includes(MAIL_READ_SCOPE)) kept.unshift(MAIL_READ_SCOPE);
  return SUPPORTED_SCOPES.filter((scope) => kept.includes(scope)).join(" ");
}

function redirectToClient(
  res: ServerResponse,
  redirectUri: string,
  config: OAuthConfig,
  params: Record<string, string | undefined>,
): void {
  const target = new URL(redirectUri);
  for (const [name, value] of Object.entries(params)) {
    if (value !== undefined) target.searchParams.set(name, value);
  }
  target.searchParams.set("iss", config.issuer);
  res.writeHead(303, { location: target.toString(), "content-length": 0, "cache-control": "no-store" });
  res.end();
}

// ---------- token + revoke ----------

interface ClientAuth {
  client: OAuthClient;
}

async function readTokenForm(req: IncomingMessage, res: ServerResponse, ctx: Ctx): Promise<URLSearchParams | null> {
  const ip = clientAddress(req, ctx.trustProxy);
  if (!ctx.tokenLimit.allow(`token:${ip}`)) {
    req.resume();
    writeOAuthError(res, new OAuthError("slow_down", "Too many requests", 429), { "retry-after": "60" });
    return null;
  }
  if (contentType(req) !== "application/x-www-form-urlencoded") {
    req.resume();
    writeOAuthError(res, new OAuthError("invalid_request", "Content-Type must be application/x-www-form-urlencoded"));
    return null;
  }
  const body = await readBody(req, FORM_BODY_LIMIT);
  if (!body.ok) {
    writeOAuthError(res, new OAuthError("invalid_request", "Request body is too large or unreadable"));
    return null;
  }
  const form = new URLSearchParams(body.body.toString("utf8"));
  for (const name of new Set(form.keys())) {
    if (form.getAll(name).length > 1) {
      writeOAuthError(res, new OAuthError("invalid_request", `Parameter ${name} must not be repeated`));
      return null;
    }
  }
  return form;
}

function authenticateClient(req: IncomingMessage, form: URLSearchParams, ctx: Ctx): ClientAuth {
  const basic = parseBasicAuth(req.headers.authorization);
  if (basic === "invalid") throw new OAuthError("invalid_client", "Malformed Basic authorization", 401);
  const bodyId = form.get("client_id") ?? undefined;
  if (basic && bodyId !== undefined && bodyId !== basic.id) {
    throw new OAuthError("invalid_request", "client_id does not match the Authorization header");
  }
  if (form.has("client_assertion") || form.has("client_assertion_type")) {
    throw new OAuthError("invalid_client", "private_key_jwt is not supported; use a public client (none)", 401);
  }
  const clientId = basic ? basic.id : bodyId;
  if (!clientId) throw new OAuthError("invalid_client", "client_id is required", 401);
  const client = getStoredClient(ctx.db, clientId);
  if (!client) throw new OAuthError("invalid_client", "Unknown client", 401);
  if (client.hasSecret) {
    const secret = basic ? basic.secret : (form.get("client_secret") ?? "");
    if (!secret || !verifyClientSecret(ctx.db, client.id, secret)) {
      throw new OAuthError("invalid_client", "Client authentication failed", 401);
    }
  }
  return { client };
}

async function handleToken(req: IncomingMessage, res: ServerResponse, ctx: Ctx): Promise<void> {
  const form = await readTokenForm(req, res, ctx);
  if (!form) return;
  try {
    const { client } = authenticateClient(req, form, ctx);
    const resourceRaw = form.get("resource") ?? undefined;
    if (resourceRaw !== undefined && !isOurResource(ctx.config, resourceRaw)) {
      throw new OAuthError("invalid_target", `resource must be ${ctx.config.resource}`);
    }
    const resource = resourceRaw === undefined ? undefined : ctx.config.resource;
    const grantType = form.get("grant_type");
    let issued: IssuedTokens;
    if (grantType === "authorization_code") {
      const code = form.get("code");
      if (!code) throw new OAuthError("invalid_request", "code is required");
      issued = redeemAuthorizationCode(ctx.db, {
        client,
        code,
        redirectUri: form.get("redirect_uri") ?? undefined,
        codeVerifier: form.get("code_verifier") ?? undefined,
        resource,
      });
    } else if (grantType === "refresh_token") {
      const refreshToken = form.get("refresh_token");
      if (!refreshToken) throw new OAuthError("invalid_request", "refresh_token is required");
      const scopeRaw = form.get("scope");
      let scope: string | undefined;
      if (scopeRaw !== null && scopeRaw.trim() !== "") {
        const parsed = parseScope(scopeRaw);
        if (!parsed.ok) throw new OAuthError("invalid_scope", `Supported scopes: ${SUPPORTED_SCOPES.join(" ")}`);
        scope = parsed.scope;
      }
      issued = refreshGrant(ctx.db, { client, refreshToken, scope, resource });
    } else {
      throw new OAuthError("unsupported_grant_type", "grant_type must be authorization_code or refresh_token");
    }
    writeJson(
      res,
      200,
      {
        access_token: issued.accessToken,
        token_type: "Bearer",
        expires_in: issued.expiresIn,
        refresh_token: issued.refreshToken,
        scope: issued.scope,
      },
      { ...corsHeaders(), pragma: "no-cache" },
    );
  } catch (err) {
    if (err instanceof OAuthError) {
      writeOAuthError(res, err, err.status === 401 && req.headers.authorization ? { "www-authenticate": 'Basic realm="openmail"' } : {});
      return;
    }
    throw err;
  }
}

async function handleRevoke(req: IncomingMessage, res: ServerResponse, ctx: Ctx): Promise<void> {
  const form = await readTokenForm(req, res, ctx);
  if (!form) return;
  try {
    const { client } = authenticateClient(req, form, ctx);
    const token = form.get("token");
    if (!token) throw new OAuthError("invalid_request", "token is required");
    revokeToken(ctx.db, { client, token });
    res.writeHead(200, { ...corsHeaders(), "content-length": 0, "cache-control": "no-store" });
    res.end();
  } catch (err) {
    if (err instanceof OAuthError) {
      writeOAuthError(res, err);
      return;
    }
    throw err;
  }
}

function parseBasicAuth(header: string | undefined): { id: string; secret: string } | "invalid" | null {
  if (!header) return null;
  const match = /^Basic\s+([A-Za-z0-9+/=]+)$/i.exec(header.trim());
  if (!match) return /^Basic\b/i.test(header.trim()) ? "invalid" : null;
  const decoded = Buffer.from(match[1] as string, "base64").toString("utf8");
  const colon = decoded.indexOf(":");
  if (colon <= 0) return "invalid";
  try {
    return {
      id: decodeURIComponent(decoded.slice(0, colon).replace(/\+/g, "%20")),
      secret: decodeURIComponent(decoded.slice(colon + 1).replace(/\+/g, "%20")),
    };
  } catch {
    return "invalid";
  }
}

// ---------- helpers ----------

function corsHeaders(): Record<string, string> {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "authorization, content-type, mcp-protocol-version",
    "access-control-max-age": "600",
  };
}

function contentType(req: IncomingMessage): string {
  const header = req.headers["content-type"];
  return (typeof header === "string" ? header : "").split(";")[0]?.trim().toLowerCase() ?? "";
}

function cookieHeader(req: IncomingMessage): string | undefined {
  const header = req.headers.cookie;
  return typeof header === "string" ? header : undefined;
}

function writeOAuthError(res: ServerResponse, err: OAuthError, extra: Record<string, string> = {}): void {
  writeJson(res, err.status, { error: err.code, error_description: err.description }, { ...corsHeaders(), ...extra });
}

function writeJson(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}, head = false): void {
  const payload = Buffer.from(JSON.stringify(body), "utf8");
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": payload.length,
    "cache-control": "no-store",
    ...extra,
  });
  res.end(head ? undefined : payload);
}

function writeHtml(res: ServerResponse, status: number, html: string, extra: Record<string, string> = {}): void {
  const payload = Buffer.from(html, "utf8");
  res.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "content-length": payload.length,
    "cache-control": "no-store",
    ...extra,
  });
  res.end(payload);
}

function methodNotAllowed(req: IncomingMessage, res: ServerResponse, allow: string, json = true): void {
  req.resume();
  if (json) {
    writeJson(res, 405, { error: "invalid_request", error_description: "Method not allowed" }, { allow });
    return;
  }
  writeHtml(res, 405, statusPage("Method not allowed", "Method not allowed."), { allow });
}
