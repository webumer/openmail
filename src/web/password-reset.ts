import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type Database from "better-sqlite3";
import { MailError } from "../errors.js";
import { issuePasswordReset, completePasswordReset } from "../services/password-resets.js";
import { recordMetric, type MetricRecorder } from "../services/metrics.js";
import { unconfiguredMailer, type SystemMailer } from "../services/system-mailer.js";
import { parseEmail, requireUserPassword } from "../services/validate.js";
import { SlidingWindowRateLimit } from "../server/rate-limit.js";
import { CSRF_COOKIE, PRESESSION_CSRF_MAX_AGE_SECONDS, readCookies, serializeCookie } from "./cookies.js";
import { resetPage, statusPage } from "./pages.js";
import { clientAddress, formFields, isFormContentType, readBody, requestUrl } from "./request.js";
import { rateLimitEmail } from "./rate.js";
import { safeEqual } from "./session.js";

interface ResetOptions {
  db: Database;
  publicUrl?: string;
  systemMailer?: SystemMailer;
  metrics?: MetricRecorder;
  secureCookies: boolean;
  trustProxy: boolean;
  bodyLimit: number;
}

const NEUTRAL = "If an account exists for that address, we sent a link to reset its password. Check your inbox. You can try again later if it does not arrive.";
const UNCONFIGURED = "Password reset by email isn't switched on yet. Email support@openmail.tools from the address you signed up with and we'll help.";

export function createPasswordResetHandler(options: ResetOptions): (req: IncomingMessage, res: ServerResponse) => Promise<boolean> {
  const requestIps = new SlidingWindowRateLimit(5, 15 * 60_000);
  const requestEmails = new SlidingWindowRateLimit(3, 60 * 60_000);
  const resetIps = new SlidingWindowRateLimit(10, 15 * 60_000);
  const mailer = options.systemMailer ?? unconfiguredMailer;
  const configured = mailer.configured && Boolean(options.publicUrl);
  return async (req, res) => {
    const path = requestUrl(req).pathname;
    if (path !== "/forgot" && path !== "/reset") return false;
    if (req.method === "GET") {
      req.resume();
      const csrf = randomBytes(32).toString("base64url");
      html(res, 200, resetPage({ mode: path === "/forgot" ? "forgot" : "reset", csrf,
        ...(path === "/forgot" && !configured ? { message: UNCONFIGURED } : {}) }),
      serializeCookie(CSRF_COOKIE, csrf, { maxAge: PRESESSION_CSRF_MAX_AGE_SECONDS, secure: options.secureCookies }));
      return true;
    }
    if (req.method !== "POST") {
      req.resume();
      res.setHeader("allow", "GET, POST");
      html(res, 405, statusPage("Method not allowed", "Method not allowed."));
      return true;
    }
    if (!isFormContentType(typeof req.headers["content-type"] === "string" ? req.headers["content-type"] : undefined)) {
      req.resume();
      html(res, 415, statusPage("Unsupported media type", "Submit the form from this site."));
      return true;
    }
    const body = await readBody(req, options.bodyLimit);
    if (!body.ok) {
      html(res, body.status, statusPage("Bad request", body.message));
      return true;
    }
    const fields = formFields(body.body);
    const csrf = readCookies(typeof req.headers.cookie === "string" ? req.headers.cookie : undefined).get(CSRF_COOKIE);
    if (!csrf || !fields._csrf || !safeEqual(csrf, fields._csrf)) {
      html(res, 403, statusPage("Forbidden", "The form expired or the request was rejected."));
      return true;
    }
    const ip = clientAddress(req, options.trustProxy);
    if (path === "/forgot") {
      const email = rateLimitEmail(fields.email);
      const allowed = requestIps.allow(ip) && (!email || requestEmails.allow(email));
      recordMetric(options.metrics, { kind: "auth", name: "reset_request", outcome: allowed ? (configured ? "ok" : "failed") : "rate_limited" });
      html(res, 200, statusPage("Password reset", configured ? NEUTRAL : UNCONFIGURED));
      // Defer lookup, token creation and delivery until after responding, even for unknown users.
      if (allowed && configured) {
        setImmediate(() => {
          void (async () => {
            const normalized = parseEmail(email);
            const row = options.db.prepare("SELECT id, email FROM users WHERE email = ?").get(normalized) as { id: string; email: string } | undefined;
            if (!row) return;
            const token = issuePasswordReset(options.db, row.id);
            const link = `${options.publicUrl?.replace(/\/+$/, "")}/reset#token=${token}`;
            await mailer.sendPasswordReset(row.email, link, token);
          })().catch(() => { /* Never log delivery errors or expose account existence. */ });
        });
      }
      return true;
    }
    if (!resetIps.allow(ip)) {
      recordMetric(options.metrics, { kind: "auth", name: "reset_complete", outcome: "rate_limited" });
      res.setHeader("retry-after", "900");
      html(res, 429, statusPage("Too many attempts", "Try again in a few minutes."));
      return true;
    }
    try {
      const password = requireUserPassword(fields.password);
      if (password !== fields.confirm) throw new MailError("invalid_argument", "Passwords do not match");
      await completePasswordReset(options.db, (fields.token ?? "").trim(), password);
      recordMetric(options.metrics, { kind: "auth", name: "reset_complete", outcome: "ok" });
      html(res, 200, resetPage({ mode: "reset", csrf, passwordChanged: true,
        message: "Password changed. Sign in again. All web sessions were signed out. Your API keys and connected apps still work — review them on the dashboard." }));
    } catch (err) {
      recordMetric(options.metrics, { kind: "auth", name: "reset_complete", outcome: "failed" });
      const message = err instanceof MailError ? err.message : "The request could not be completed.";
      html(res, 400, resetPage({ mode: "reset", csrf, errors: [message] }));
    }
    return true;
  };
}

function html(res: ServerResponse, status: number, page: string, cookie?: string): void {
  res.writeHead(status, { "content-type": "text/html; charset=utf-8", "content-length": Buffer.byteLength(page),
    "cache-control": "no-store", ...(cookie ? { "set-cookie": cookie } : {}) });
  res.end(page);
}
