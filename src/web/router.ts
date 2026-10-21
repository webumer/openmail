import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { OutgoingHttpHeaders } from "node:http";
import type Database from "better-sqlite3";
import { scrubSecret, toMailError, MailError } from "../errors.js";
import type { ImapGateway } from "../mail/imap-gateway.js";
import { resolveEndpoints } from "../mail/presets.js";
import { SlidingWindowRateLimit } from "../server/rate-limit.js";
import { apiKeys, mailAccounts, users } from "../services/index.js";
import type { AccountCredentials } from "../store/types.js";
import {
  CSRF_COOKIE,
  PRESESSION_CSRF_MAX_AGE_SECONDS,
  SESSION_COOKIE,
  SESSION_MAX_AGE_SECONDS,
  clearCookie,
  readCookies,
  serializeCookie,
} from "./cookies.js";
import { emptyAccountDraft, parseAccountForm, parseKeyName, parseLogin, parseSignup, type AccountDraft, type ParsedAccount } from "./forms.js";
import {
  authPage,
  dashboardPage,
  homePage,
  keyRevealPage,
  privacyPage,
  statusPage,
  reviewersPage,
  termsPage,
} from "./pages.js";
import { renderMarkdown } from "./markdown.js";
import { checkCustomHost } from "./host-guard.js";
import { mcpUrl } from "./public-url.js";
import { AUTH_ATTEMPT_LIMIT, AUTH_ATTEMPT_WINDOW_MS, attemptAllowed, rateLimitEmail } from "./rate.js";
import { clientAddress, formFields, isFormContentType, readBody, requestUrl, reviewerGuideMarkdown, staticFile } from "./request.js";
import { createSession, destroySession, readSession, safeEqual, type SessionRecord } from "./session.js";

export interface WebAppConfig {
  db: Database;
  masterKey: Buffer;
  allowInsecureLocalhost?: boolean;
  /** Defaults to true. `false` is refused when NODE_ENV is production. */
  secureCookies?: boolean;
  authRateLimit?: { limit: number; windowMs: number };
}

export interface WebRuntime {
  db: Database;
  masterKey: Buffer;
  imap: ImapGateway;
  publicUrl?: string;
  trustProxy: boolean;
  allowInsecureLocalhost: boolean;
  secureCookies: boolean;
  bodyLimit: number;
  authRateLimit?: { limit: number; windowMs: number };
  /** Mailbox sign-in attempts (test or add) per user. */
  probeRateLimit?: { limit: number; windowMs: number };
}

/** Each "test connection" or "add account" opens one IMAP login. */
export const PROBE_ATTEMPT_LIMIT = 20;
export const PROBE_ATTEMPT_WINDOW_MS = 15 * 60 * 1000;

const NOTICES: Record<string, string> = {
  "account-added": "Mail account saved.",
  "account-removed": "Mail account removed.",
  "key-revoked": "API key revoked.",
  "logged-out": "You have been logged out.",
};

const ACCOUNT_DELETE =
  /^\/accounts\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/delete$/i;
const KEY_REVOKE = /^\/keys\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/revoke$/i;

interface Handler extends WebRuntime {
  loginAttempts: SlidingWindowRateLimit;
  signupAttempts: SlidingWindowRateLimit;
  probeAttempts: SlidingWindowRateLimit;
}

export function createWebHandler(options: WebRuntime): (req: IncomingMessage, res: ServerResponse) => Promise<boolean> {
  const limit = options.authRateLimit?.limit ?? AUTH_ATTEMPT_LIMIT;
  const windowMs = options.authRateLimit?.windowMs ?? AUTH_ATTEMPT_WINDOW_MS;
  const handler: Handler = {
    ...options,
    loginAttempts: new SlidingWindowRateLimit(limit, windowMs),
    signupAttempts: new SlidingWindowRateLimit(limit, windowMs),
    probeAttempts: new SlidingWindowRateLimit(
      options.probeRateLimit?.limit ?? PROBE_ATTEMPT_LIMIT,
      options.probeRateLimit?.windowMs ?? PROBE_ATTEMPT_WINDOW_MS,
    ),
  };
  return async (req, res) => {
    const url = requestUrl(req);
    if (!isWebPath(url.pathname)) return false;
    try {
      await route(req, res, url, handler);
    } catch {
      if (!res.headersSent && !res.writableEnded) {
        writeHtml(res, 500, statusPage("Something went wrong", "The request could not be completed."));
      }
    }
    return true;
  };
}

async function route(req: IncomingMessage, res: ServerResponse, url: URL, handler: Handler): Promise<void> {
  const pathname = url.pathname;
  const file = staticFile(pathname);
  if (file) {
    if (req.method !== "GET" && req.method !== "HEAD") {
      methodNotAllowed(req, res, "GET");
      return;
    }
    req.resume();
    res.writeHead(req.method === "HEAD" ? 200 : 200, {
      "content-type": file.type,
      "content-length": file.body.length,
      "cache-control": "public, max-age=3600",
    });
    res.end(req.method === "HEAD" ? undefined : file.body);
    return;
  }

  const accountDelete = ACCOUNT_DELETE.exec(pathname);
  const keyRevoke = KEY_REVOKE.exec(pathname);
  if (pathname === "/" && req.method === "GET") return renderHome(req, res, url, handler);
  if (pathname === "/privacy" && req.method === "GET") return renderStatic(req, res, handler, "privacy");
  if (pathname === "/terms" && req.method === "GET") return renderStatic(req, res, handler, "terms");
  if (pathname === "/reviewers" && req.method === "GET") return renderStatic(req, res, handler, "reviewers");
  if (pathname === "/signup" && req.method === "GET") return renderAuth(req, res, handler, "signup");
  if (pathname === "/signup" && req.method === "POST") return submitAuth(req, res, handler, "signup");
  if (pathname === "/login" && req.method === "GET") return renderAuth(req, res, handler, "login");
  if (pathname === "/login" && req.method === "POST") return submitAuth(req, res, handler, "login");
  if (pathname === "/logout" && req.method === "POST") return submitLogout(req, res, handler);
  if (pathname === "/dashboard" && req.method === "GET") return renderDashboard(req, res, url, handler);
  if (pathname === "/accounts" && req.method === "POST") return submitAccount(req, res, url, handler, false);
  if (pathname === "/accounts/test" && req.method === "POST") return submitAccount(req, res, url, handler, true);
  if (accountDelete && req.method === "POST") return submitAccountDelete(req, res, handler, accountDelete[1] ?? "");
  if (pathname === "/keys" && req.method === "POST") return submitKey(req, res, url, handler);
  if (keyRevoke && req.method === "POST") return submitKeyRevoke(req, res, handler, keyRevoke[1] ?? "");

  const allow = allowHeader(pathname, accountDelete !== null, keyRevoke !== null);
  methodNotAllowed(req, res, allow);
}

function isWebPath(pathname: string): boolean {
  return (
    pathname === "/" ||
    pathname === "/privacy" ||
    pathname === "/terms" ||
    pathname === "/reviewers" ||
    pathname === "/logo.svg" ||
    pathname === "/logo.png" ||
    pathname === "/favicon.ico" ||
    pathname === "/signup" ||
    pathname === "/login" ||
    pathname === "/logout" ||
    pathname === "/dashboard" ||
    pathname === "/accounts" ||
    pathname === "/accounts/test" ||
    pathname === "/keys" ||
    pathname === "/static/style.css" ||
    pathname === "/static/app.js" ||
    ACCOUNT_DELETE.test(pathname) ||
    KEY_REVOKE.test(pathname)
  );
}

function allowHeader(pathname: string, accountDelete: boolean, keyRevoke: boolean): string {
  if (pathname === "/logout" || pathname === "/accounts" || pathname === "/accounts/test" || pathname === "/keys" || accountDelete || keyRevoke) {
    return "POST";
  }
  if (pathname === "/signup" || pathname === "/login") return "GET, POST";
  return "GET";
}

function renderHome(req: IncomingMessage, res: ServerResponse, url: URL, handler: Handler): void {
  req.resume();
  const cookies = readCookies(cookieHeader(req));
  const session = readSession(handler.db, cookies.get(SESSION_COOKIE));
  writeHtml(
    res,
    200,
    homePage({
      email: session?.email ?? null,
      ...(session ? { csrf: session.csrfSecret } : {}),
      ...(noticeFor(url) ? { notice: noticeFor(url) } : {}),
    }),
  );
}

const REVIEWER_GUIDE_HTML = renderMarkdown(reviewerGuideMarkdown());

function renderStatic(
  req: IncomingMessage,
  res: ServerResponse,
  handler: Handler,
  page: "privacy" | "terms" | "reviewers",
): void {
  req.resume();
  const session = readSession(handler.db, readCookies(cookieHeader(req)).get(SESSION_COOKIE));
  const csrf = session ? { csrf: session.csrfSecret } : {};
  const html =
    page === "privacy" ? privacyPage(csrf) : page === "terms" ? termsPage(csrf) : reviewersPage(REVIEWER_GUIDE_HTML, csrf);
  writeHtml(res, 200, html);
}

function renderAuth(req: IncomingMessage, res: ServerResponse, handler: Handler, mode: "signup" | "login"): void {
  req.resume();
  const cookies = readCookies(cookieHeader(req));
  if (readSession(handler.db, cookies.get(SESSION_COOKIE))) {
    redirect(res, "/dashboard");
    return;
  }
  const issued = issuePreSessionCsrf(handler.secureCookies);
  writeHtml(res, 200, authPage({ mode, csrf: issued.token }), [issued.cookie]);
}

async function submitAuth(
  req: IncomingMessage,
  res: ServerResponse,
  handler: Handler,
  mode: "signup" | "login",
): Promise<void> {
  const cookies = readCookies(cookieHeader(req));
  const fields = await readForm(req, res, handler.bodyLimit);
  if (!fields) return;
  const expected = cookies.get(CSRF_COOKIE);
  const presented = fields._csrf ?? "";
  if (!expected || !presented || !safeEqual(expected, presented)) {
    forbidden(res);
    return;
  }
  const ip = clientAddress(req, handler.trustProxy);
  const limiter = mode === "signup" ? handler.signupAttempts : handler.loginAttempts;
  if (!attemptAllowed(limiter, mode, ip, rateLimitEmail(fields.email))) {
    limited(res);
    return;
  }
  const parsed = mode === "signup" ? parseSignup(fields) : parseLogin(fields);
  if (!parsed.email || parsed.password === undefined || parsed.errors.length > 0) {
    writeHtml(res, 400, authPage({ mode, csrf: expected, email: clipField(fields.email), errors: parsed.errors }));
    return;
  }
  if (mode === "signup") {
    try {
      const user = await users.create(handler.db, handler.masterKey, { email: parsed.email, password: parsed.password });
      startSession(res, handler, cookies.get(SESSION_COOKIE), user.id);
    } catch (err) {
      const message = safeMailMessage(err, parsed.password);
      if (!message) throw err;
      const status = err instanceof MailError && err.code === "conflict" ? 409 : 400;
      writeHtml(res, status, authPage({ mode, csrf: expected, email: parsed.email, errors: [message] }));
    }
    return;
  }
  const user = await users.verifyPassword(handler.db, { email: parsed.email, password: parsed.password });
  if (!user) {
    writeHtml(
      res,
      401,
      authPage({ mode, csrf: expected, email: parsed.email, errors: ["Email or password is incorrect"] }),
    );
    return;
  }
  startSession(res, handler, cookies.get(SESSION_COOKIE), user.id);
}

async function submitLogout(req: IncomingMessage, res: ServerResponse, handler: Handler): Promise<void> {
  const cookies = readCookies(cookieHeader(req));
  const token = cookies.get(SESSION_COOKIE);
  const session = readSession(handler.db, token);
  if (!session) {
    req.resume();
    redirect(res, "/", [clearCookie(SESSION_COOKIE, handler.secureCookies)]);
    return;
  }
  const fields = await readForm(req, res, handler.bodyLimit);
  if (!fields) return;
  if (!csrfOk(session, fields)) {
    forbidden(res);
    return;
  }
  destroySession(handler.db, token);
  redirect(res, "/?notice=logged-out", [
    clearCookie(SESSION_COOKIE, handler.secureCookies),
    clearCookie(CSRF_COOKIE, handler.secureCookies),
  ]);
}

function renderDashboard(req: IncomingMessage, res: ServerResponse, url: URL, handler: Handler): void {
  req.resume();
  const session = currentSession(req, handler);
  if (!session) {
    redirect(res, "/login");
    return;
  }
  writeDashboard(res, handler, session, { draft: emptyAccountDraft(), notice: noticeFor(url) });
}

async function submitAccount(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  handler: Handler,
  probeOnly: boolean,
): Promise<void> {
  const session = currentSession(req, handler);
  if (!session) {
    req.resume();
    redirect(res, "/login");
    return;
  }
  const fields = await readForm(req, res, handler.bodyLimit);
  if (!fields) return;
  if (!csrfOk(session, fields)) {
    forbidden(res);
    return;
  }
  const parsed = parseAccountForm(fields);
  delete fields.password;
  const notice = noticeFor(url);
  if (!parsed.account || parsed.errors.length > 0) {
    writeDashboard(res, handler, session, { draft: parsed.draft, errors: parsed.errors, notice }, 400);
    return;
  }
  if (!handler.probeAttempts.allow(`probe:${session.userId}`)) {
    limited(res);
    return;
  }
  const failure = (await hostProblem(handler, parsed.account)) ?? (await imapProbe(handler, parsed.account));
  if (failure) {
    writeDashboard(res, handler, session, { draft: parsed.draft, errors: [failure], notice }, 400);
    return;
  }
  if (probeOnly) {
    writeDashboard(res, handler, session, {
      draft: parsed.draft,
      notice,
      probeMessage: "Signed in to IMAP. The account was not saved.",
    });
    return;
  }
  try {
    mailAccounts.add(handler.db, handler.masterKey, accountInput(session.userId, parsed.account));
  } catch (err) {
    const message = safeMailMessage(err, parsed.account.password);
    if (!message) throw err;
    writeDashboard(res, handler, session, { draft: parsed.draft, errors: [message], notice }, 400);
    return;
  }
  redirect(res, "/dashboard?notice=account-added");
}

async function submitAccountDelete(req: IncomingMessage, res: ServerResponse, handler: Handler, accountId: string): Promise<void> {
  const session = currentSession(req, handler);
  if (!session) {
    req.resume();
    redirect(res, "/login");
    return;
  }
  const fields = await readForm(req, res, handler.bodyLimit);
  if (!fields) return;
  if (!csrfOk(session, fields)) {
    forbidden(res);
    return;
  }
  if (!mailAccounts.remove(handler.db, session.userId, accountId)) {
    writeHtml(res, 404, statusPage("Not found", "Mail account was not found."));
    return;
  }
  redirect(res, "/dashboard?notice=account-removed");
}

async function submitKey(req: IncomingMessage, res: ServerResponse, url: URL, handler: Handler): Promise<void> {
  const session = currentSession(req, handler);
  if (!session) {
    req.resume();
    redirect(res, "/login");
    return;
  }
  const fields = await readForm(req, res, handler.bodyLimit);
  if (!fields) return;
  if (!csrfOk(session, fields)) {
    forbidden(res);
    return;
  }
  const parsed = parseKeyName(fields);
  if (!parsed.name || parsed.errors.length > 0) {
    writeDashboard(res, handler, session, {
      draft: emptyAccountDraft(),
      errors: parsed.errors,
      notice: noticeFor(url),
    }, 400);
    return;
  }
  let created: { name: string; token: string; prefix: string };
  try {
    created = apiKeys.create(handler.db, { userId: session.userId, name: parsed.name });
  } catch (err) {
    const message = safeMailMessage(err);
    if (!message) throw err;
    writeDashboard(res, handler, session, { draft: emptyAccountDraft(), errors: [message], notice: noticeFor(url) }, 400);
    return;
  }
  writeHtml(
    res,
    200,
    keyRevealPage({ csrf: session.csrfSecret, name: created.name, token: created.token, prefix: created.prefix }),
  );
}

async function submitKeyRevoke(req: IncomingMessage, res: ServerResponse, handler: Handler, keyId: string): Promise<void> {
  const session = currentSession(req, handler);
  if (!session) {
    req.resume();
    redirect(res, "/login");
    return;
  }
  const fields = await readForm(req, res, handler.bodyLimit);
  if (!fields) return;
  if (!csrfOk(session, fields)) {
    forbidden(res);
    return;
  }
  if (!apiKeys.revoke(handler.db, session.userId, keyId)) {
    writeHtml(res, 404, statusPage("Not found", "API key was not found."));
    return;
  }
  redirect(res, "/dashboard?notice=key-revoked");
}

function startSession(res: ServerResponse, handler: Handler, previous: string | undefined, userId: string): void {
  const created = createSession(handler.db, userId);
  if (previous) destroySession(handler.db, previous);
  redirect(res, "/dashboard", [
    serializeCookie(SESSION_COOKIE, created.token, { maxAge: SESSION_MAX_AGE_SECONDS, secure: handler.secureCookies }),
    clearCookie(CSRF_COOKIE, handler.secureCookies),
  ]);
}

function writeDashboard(
  res: ServerResponse,
  handler: Handler,
  session: SessionRecord,
  input: { draft: AccountDraft; errors?: string[]; notice?: string; probeMessage?: string },
  status = 200,
): void {
  writeHtml(
    res,
    status,
    dashboardPage({
      email: session.email,
      csrf: session.csrfSecret,
      accounts: mailAccounts.list(handler.db, session.userId),
      keys: apiKeys.list(handler.db, session.userId),
      mcpUrl: mcpUrl(handler.publicUrl),
      draft: input.draft,
      ...(input.errors && input.errors.length > 0 ? { errors: input.errors } : {}),
      ...(input.notice ? { notice: input.notice } : {}),
      ...(input.probeMessage ? { probeMessage: input.probeMessage } : {}),
    }),
  );
}

async function hostProblem(handler: Handler, account: ParsedAccount): Promise<string | null> {
  if (account.preset !== "custom") return null;
  const checks = [
    { host: account.imapHost ?? "", port: account.imapPort ?? 0, kind: "IMAP" as const },
    { host: account.smtpHost ?? "", port: account.smtpPort ?? 0, kind: "SMTP" as const },
  ];
  for (const check of checks) {
    const problem = await checkCustomHost({ ...check, allowInsecureLocalhost: handler.allowInsecureLocalhost });
    if (problem) return problem;
  }
  return null;
}

async function imapProbe(handler: Handler, account: ParsedAccount): Promise<string | null> {
  const endpoints = resolveEndpoints({
    preset: account.preset,
    ...(account.zohoRegion ? { zohoRegion: account.zohoRegion } : {}),
    ...(account.imapHost !== undefined ? { imapHost: account.imapHost } : {}),
    ...(account.imapPort !== undefined ? { imapPort: account.imapPort } : {}),
    ...(account.imapSecure !== undefined ? { imapSecure: account.imapSecure } : {}),
    ...(account.smtpHost !== undefined ? { smtpHost: account.smtpHost } : {}),
    ...(account.smtpPort !== undefined ? { smtpPort: account.smtpPort } : {}),
    ...(account.smtpSecure !== undefined ? { smtpSecure: account.smtpSecure } : {}),
    ...(account.smtpStarttls !== undefined ? { smtpStarttls: account.smtpStarttls } : {}),
  });
  const credentials: AccountCredentials = {
    id: "probe",
    label: account.name,
    email: account.email,
    preset: account.preset,
    username: account.username,
    password: account.password,
    imap: endpoints.imap,
    smtp: endpoints.smtp,
    allowInsecureLocalhost: handler.allowInsecureLocalhost,
  };
  try {
    await handler.imap.withClient(credentials, async () => undefined);
    return null;
  } catch (err) {
    const mail = toMailError(err, account.password);
    const clean = scrubSecret(mail.message, account.password);
    if (mail.code === "insecure_transport" && !clean.includes(account.password)) return clean;
    return "Could not sign in to that mailbox. Check the host, port, TLS, username, and password.";
  }
}

function accountInput(userId: string, account: ParsedAccount) {
  return {
    userId,
    name: account.name,
    email: account.email,
    username: account.username,
    preset: account.preset,
    password: account.password,
    ...(account.zohoRegion ? { zohoRegion: account.zohoRegion } : {}),
    ...(account.imapHost !== undefined ? { imapHost: account.imapHost } : {}),
    ...(account.imapPort !== undefined ? { imapPort: account.imapPort } : {}),
    ...(account.imapSecure !== undefined ? { imapSecure: account.imapSecure } : {}),
    ...(account.smtpHost !== undefined ? { smtpHost: account.smtpHost } : {}),
    ...(account.smtpPort !== undefined ? { smtpPort: account.smtpPort } : {}),
    ...(account.smtpSecure !== undefined ? { smtpSecure: account.smtpSecure } : {}),
    ...(account.smtpStarttls !== undefined ? { smtpStarttls: account.smtpStarttls } : {}),
  };
}

function currentSession(req: IncomingMessage, handler: Handler): SessionRecord | null {
  return readSession(handler.db, readCookies(cookieHeader(req)).get(SESSION_COOKIE));
}

function csrfOk(session: SessionRecord, fields: Record<string, string>): boolean {
  const presented = fields._csrf ?? "";
  if (!presented) return false;
  return safeEqual(session.csrfSecret, presented);
}

function issuePreSessionCsrf(secure: boolean): { token: string; cookie: string } {
  const token = randomBytes(32).toString("base64url");
  return {
    token,
    cookie: serializeCookie(CSRF_COOKIE, token, { maxAge: PRESESSION_CSRF_MAX_AGE_SECONDS, secure }),
  };
}

async function readForm(
  req: IncomingMessage,
  res: ServerResponse,
  limit: number,
): Promise<Record<string, string> | null> {
  const header = req.headers["content-type"];
  if (!isFormContentType(typeof header === "string" ? header : undefined)) {
    req.resume();
    writeHtml(res, 415, statusPage("Unsupported media type", "Submit the form from this site."));
    return null;
  }
  const body = await readBody(req, limit);
  if (!body.ok) {
    const title = body.status === 413 ? "Payload too large" : "Bad request";
    writeHtml(res, body.status, statusPage(title, body.message));
    return null;
  }
  return formFields(body.body);
}

function noticeFor(url: URL): string | undefined {
  const code = url.searchParams.get("notice") ?? "";
  return NOTICES[code];
}

function forbidden(res: ServerResponse): void {
  writeHtml(res, 403, statusPage("Forbidden", "The form expired or the request was rejected."));
}

function limited(res: ServerResponse): void {
  writeHtml(res, 429, statusPage("Too many attempts", "Try again in a few minutes."), [], { "retry-after": "900" });
}

function methodNotAllowed(req: IncomingMessage, res: ServerResponse, allow: string): void {
  req.resume();
  writeHtml(res, 405, statusPage("Method not allowed", "Method not allowed."), [], { allow });
}

function safeMailMessage(err: unknown, secret?: string): string | null {
  if (!(err instanceof MailError)) return null;
  const clean = scrubSecret(err.message, secret);
  if (secret && (clean.includes(secret) || clean !== err.message)) return "The request could not be completed.";
  return clean;
}

function clipField(value: string | undefined): string {
  return (value ?? "").trim().slice(0, 254);
}

function cookieHeader(req: IncomingMessage): string | undefined {
  const header = req.headers.cookie;
  return typeof header === "string" ? header : undefined;
}

function writeHtml(
  res: ServerResponse,
  status: number,
  html: string,
  cookies: string[] = [],
  extra?: OutgoingHttpHeaders,
): void {
  const payload = Buffer.from(html, "utf8");
  res.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "content-length": payload.length,
    "cache-control": "no-store",
    ...extra,
    ...(cookies.length > 0 ? { "set-cookie": cookies } : {}),
  });
  res.end(payload);
}

function redirect(res: ServerResponse, location: string, cookies: string[] = []): void {
  if (!location.startsWith("/") || /[\r\n]/.test(location)) throw new Error("Invalid redirect");
  res.writeHead(303, {
    location,
    "content-type": "text/plain; charset=utf-8",
    "content-length": 0,
    "cache-control": "no-store",
    ...(cookies.length > 0 ? { "set-cookie": cookies } : {}),
  });
  res.end();
}
