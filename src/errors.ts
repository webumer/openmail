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
