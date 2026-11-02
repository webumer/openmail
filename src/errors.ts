export const FAILURE_CATEGORIES = ["auth_failed", "timeout", "tls", "host_not_found", "connection_refused", "imap_disabled", "host_not_allowed", "unknown"] as const;
export type FailureCategory = (typeof FAILURE_CATEGORIES)[number];

/** Inspect raw library fields before replacing server text with safe messages. */
export function failureCategory(err: unknown): FailureCategory {
  if (err instanceof MailError && err.category) return err.category;
  const raw = err && typeof err === "object" ? err as Record<string, unknown> : {};
  const code = typeof raw.code === "string" ? raw.code.toUpperCase() : "";
  const responseCode = String(raw.serverResponseCode ?? raw.responseCode ?? "").toUpperCase();
  // A syscall errno is safe to recognize in a message; arbitrary message text may be a hostname.
  const errno = code || /\b(ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ESOCKETTIMEDOUT|ECONNREFUSED|ECONNRESET|ENETUNREACH|EHOSTUNREACH)\b/.exec(errorText(err))?.[1] || "";
  if (["BLOCKED_HOST", "INSECURE_TRANSPORT", "HOST_NOT_ALLOWED"].includes(code)) return "host_not_allowed";
  if (["ENOTFOUND", "EAI_AGAIN"].includes(errno)) return "host_not_found";
  // imapflow uses CONNECT_TIMEOUT / GREETING_TIMEOUT / UPGRADE_TIMEOUT / ETIMEOUT and NoConnection.
  if (["ETIMEDOUT", "ESOCKETTIMEDOUT", "ETIMEOUT", "CONNECT_TIMEOUT", "GREETING_TIMEOUT", "UPGRADE_TIMEOUT"].includes(errno)) return "timeout";
  if (["ECONNREFUSED", "ECONNRESET", "ECONNECTION", "ENETUNREACH", "EHOSTUNREACH", "NOCONNECTION"].includes(errno)) return "connection_refused";
  if (code === "ETLS" || /CERT_|CERTIFICATE|UNABLE_TO_VERIFY|SELF_SIGNED|ERR_TLS|ERR_SSL/.test(code)) return "tls";
  if (responseCode === "LOGINDISABLED") return "imap_disabled";
  const text = [raw.responseText, raw.response].filter((value) => typeof value === "string").join(" ");
  if (/application[- ]specific password|app[- ]?password.{0,40}(required|needed)|web login required|imap.{0,30}(disabled|not enabled)|basic.{0,20}auth.{0,60}(disabled|not supported|not allowed)|SmtpClientAuthentication.{0,30}disabled|user is authenticated but not connected|authentication.{0,20}(disabled|not supported)|password.{0,20}(sign-in|authentication).{0,30}(disabled|not supported)|AUTHENTICATE failed.*outlook|LOGIN disabled|logindisabled/i.test(text)) return "imap_disabled";
  if (raw.authenticationFailed === true || code === "EAUTH" || responseCode === "AUTHENTICATIONFAILED" || responseCode === "535") return "auth_failed";
  if (/SSL|TLS|certificate|hostname\/ip does not match/i.test(text)) return "tls";
  if (/timed? ?out|timeout|greeting never received/i.test(text)) return "timeout";
  if (/AUTHENTICATIONFAILED|Invalid (credentials|login)|LOGIN failed|AUTHENTICATE failed|auth(entication)? failed|535[ -]/i.test(text)) return "auth_failed";
  return "unknown";
}

export class MailError extends Error {
  readonly code: string;
  readonly category?: FailureCategory;

  constructor(code: string, message: string, category?: FailureCategory) {
    super(message);
    this.name = "MailError";
    this.code = code;
    if (category) this.category = category;
  }
}

export function errorText(err: unknown): string {
  if (err instanceof Error && err.message) return err.message;
  return "Unexpected error";
}

/** Replace a secret if a library error echoed it. Empty secrets are left alone. */
export function scrubSecret(message: string, secret: string | undefined): string {
  if (!secret) return message;
  return message.split(secret).join("[redacted]");
}

export function toMailError(err: unknown, secret?: string): MailError {
  if (err instanceof MailError) {
    const scrubbed = scrubSecret(err.message, secret);
    return new MailError(err.code, scrubbed, failureCategory(err));
  }
  const raw = err && typeof err === "object" ? err as Record<string, unknown> : {};
  const response = [raw.responseText, raw.response].filter((value) => typeof value === "string").join(" ");
  if ([raw.code, raw.serverResponseCode].some((value) => value === "NONEXISTENT" || value === "NoSuchMailbox") ||
    /does(?:n't| not) exist|NONEXISTENT|NoSuchMailbox|unknown mailbox|mailbox not found/i.test(response)) {
    return new MailError("not_found", "Mailbox was not found");
  }
  // Syscall text often embeds host:port; keep that out of tool results.
  return new MailError("imap_error", classifyImapFailure(failureCategory(err)), failureCategory(err));
}

/** SMTP library failures become one of four short messages; raw library text is discarded. */
export function toSmtpError(err: unknown, secrets: readonly (string | undefined)[] = []): MailError {
  if (err instanceof MailError) {
    const message = scrubSecrets(err.message, secrets);
    return new MailError(err.code, message, failureCategory(err));
  }
  return new MailError("smtp_error", classifySmtpFailure(failureCategory(err)), failureCategory(err));
}

function scrubSecrets(message: string, secrets: readonly (string | undefined)[]): string {
  let out = message;
  for (const secret of secrets) out = scrubSecret(out, secret);
  return out;
}

function classifySmtpFailure(category: FailureCategory): string {
  if (category === "tls") return "TLS verification failed for the SMTP server";
  if (["host_not_found", "timeout", "connection_refused"].includes(category)) return "Could not reach the SMTP server";
  if (category === "auth_failed" || category === "imap_disabled") return "SMTP sign-in failed";
  return "The SMTP server rejected the message";
}

function classifyImapFailure(category: FailureCategory): string {
  if (category === "host_not_found" || category === "connection_refused") return "Could not reach the IMAP server";
  if (category === "timeout") return "The IMAP server timed out";
  if (category === "tls") return "TLS verification failed for the IMAP server";
  if (category === "auth_failed" || category === "imap_disabled") return "IMAP sign-in failed";
  return "IMAP request failed";
}

/** Operator diagnostics retain main's Error messages, plus the error name and code. */
export function operatorErrorText(err: unknown, fallback: string): string {
  if (err instanceof MailError) return err.message;
  if (!(err instanceof Error)) return fallback;
  const code = "code" in err && (typeof err.code === "string" || typeof err.code === "number") ? ` (${err.code})` : "";
  return `${err.name}${code}: ${err.message}`;
}
