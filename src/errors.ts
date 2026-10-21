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
    return new MailError("not_found", message);
  }
  return new MailError("imap_error", message);
}
