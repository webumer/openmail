export const FAILURE_CATEGORIES = ["auth_failed", "timeout", "tls", "host_not_found", "connection_refused", "imap_disabled", "host_not_allowed", "unknown"] as const;
export type FailureCategory = (typeof FAILURE_CATEGORIES)[number];

/** Inspect raw library fields before replacing server text with safe messages. */
export function failureCategory(err: unknown): FailureCategory {
  if (err instanceof MailError && err.category) return err.category;
  const raw = err && typeof err === "object" ? err as Record<string, unknown> : {};
  const text = [raw.code, raw.serverResponseCode, raw.responseCode, raw.responseText, raw.response, raw.message,
    typeof err === "string" ? err : ""].filter((v) => typeof v === "string" || typeof v === "number").join(" ");
  if (/blocked_host|insecure_transport|host_not_allowed/i.test(text)) return "host_not_allowed";
  if (/application[- ]specific password|app[- ]?password.{0,40}(required|needed)|web login required|imap.{0,30}(disabled|not enabled)|basic.{0,20}auth.{0,60}(disabled|not supported|not allowed)|SmtpClientAuthentication.{0,30}disabled|user is authenticated but not connected|authentication.{0,20}(disabled|not supported)|password.{0,20}(sign-in|authentication).{0,30}(disabled|not supported)|AUTHENTICATE failed.*outlook|LOGIN disabled|logindisabled/i.test(text)) return "imap_disabled";
  if (/CERT_|CERTIFICATE|UNABLE_TO_VERIFY|SELF_SIGNED|ERR_TLS|SSL|TLS|certificate|hostname\/ip does not match/i.test(text)) return "tls";
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo|host could not be resolved/i.test(text)) return "host_not_found";
  if (/ETIMEDOUT|ESOCKETTIMEDOUT|timed? ?out|timeout|greeting never received/i.test(text)) return "timeout";
  if (/ECONNREFUSED|ECONNRESET|ECONNECTION|ENETUNREACH|EHOSTUNREACH/i.test(text)) return "connection_refused";
  if (raw.authenticationFailed === true || /EAUTH|AUTHENTICATIONFAILED|Invalid (credentials|login)|LOGIN failed|AUTHENTICATE failed|auth(entication)? failed|535[ -]|Command failed/i.test(text)) return "auth_failed";
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
  const message = scrubSecret(errorText(err), secret);
  if (/does(?:n't| not) exist|NONEXISTENT|NoSuchMailbox|unknown mailbox|mailbox not found/i.test(message)) {
    return new MailError("not_found", "Mailbox was not found");
  }
  // Syscall text often embeds host:port; keep that out of tool results.
  return new MailError("imap_error", classifyImapFailure(message), failureCategory(err));
}

/** SMTP library failures become one of four short messages. Secrets are scrubbed first. */
export function toSmtpError(err: unknown, secrets: readonly (string | undefined)[] = []): MailError {
  if (err instanceof MailError) {
    const message = scrubSecrets(err.message, secrets);
    return new MailError(err.code, message, failureCategory(err));
  }
  return new MailError("smtp_error", classifySmtpFailure(scrubSecrets(errorText(err), secrets)), failureCategory(err));
}

function scrubSecrets(message: string, secrets: readonly (string | undefined)[]): string {
  let out = message;
  for (const secret of secrets) out = scrubSecret(out, secret);
  return out;
}

function classifySmtpFailure(message: string): string {
  if (/certificate|UNABLE_TO_VERIFY|self[- ]signed|hostname\/ip does not match|unable to verify the first certificate/i.test(message)) {
    return "TLS verification failed for the SMTP server";
  }
  if (/ECONNREFUSED|ENETUNREACH|EHOSTUNREACH|ENOTFOUND|ETIMEDOUT|ESOCKETTIMEDOUT|getaddrinfo|timed out|Greeting never received/i.test(message)) {
    return "Could not reach the SMTP server";
  }
  if (/EAUTH|Invalid login|authentication failed|535[ -]/i.test(message)) {
    return "SMTP sign-in failed";
  }
  return "The SMTP server rejected the message";
}

function classifyImapFailure(message: string): string {
  if (/ECONNREFUSED|ENETUNREACH|EHOSTUNREACH|ENOTFOUND|getaddrinfo/i.test(message)) {
    return "Could not reach the IMAP server";
  }
  if (/ETIMEDOUT|ESOCKETTIMEDOUT|Timeout|timed out/i.test(message)) {
    return "The IMAP server timed out";
  }
  if (/certificate|SSL|TLS|UNABLE_TO_VERIFY|hostname\/ip does not match/i.test(message)) {
    return "TLS verification failed for the IMAP server";
  }
  if (/AUTHENTICATIONFAILED|Invalid credentials|LOGIN failed|AUTHENTICATE failed|auth failed/i.test(message)) {
    return "IMAP sign-in failed";
  }
  if (/Command failed/i.test(message)) {
    return "IMAP sign-in failed";
  }
  return "IMAP request failed";
}
