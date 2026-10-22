export class MailError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "MailError";
    this.code = code;
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
    return scrubbed === err.message ? err : new MailError(err.code, scrubbed);
  }
  const message = scrubSecret(errorText(err), secret);
  if (/does(?:n't| not) exist|NONEXISTENT|NoSuchMailbox|unknown mailbox|mailbox not found/i.test(message)) {
    return new MailError("not_found", "Mailbox was not found");
  }
  // Syscall text often embeds host:port; keep that out of tool results.
  return new MailError("imap_error", classifyImapFailure(message));
}

/** SMTP library failures become one of four short messages. Secrets are scrubbed first. */
export function toSmtpError(err: unknown, secrets: readonly (string | undefined)[] = []): MailError {
  if (err instanceof MailError) {
    const message = scrubSecrets(err.message, secrets);
    return message === err.message ? err : new MailError(err.code, message);
  }
  return new MailError("smtp_error", classifySmtpFailure(scrubSecrets(errorText(err), secrets)));
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
