import { MailError } from "../errors.js";

/** Reject invalid settings without echoing environment values. */
export function envInteger(env: NodeJS.ProcessEnv, name: string, fallback: number, min: number, max: number): number {
  const raw = env[name];
  if (raw === undefined) return fallback;
  const value = /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new MailError("config_error", `${name} must be an integer from ${min} to ${max}`);
  }
  return value;
}

export function imapTimeoutFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  return envInteger(env, "OPENMAIL_IMAP_OP_TIMEOUT_MS", 25_000, 5_000, 120_000);
}

export function rateLimitFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  return envInteger(env, "OPENMAIL_RATE_LIMIT_PER_MINUTE", 90, 1, 10_000);
}

export interface AttachmentLimits {
  /** Largest decoded attachment get_attachment downloads, for text, PDF parsing and base64. */
  maxBytes: number;
  /** PDF pages read for text. */
  pdfMaxPages: number;
  /** Wall-clock budget for PDF text extraction. */
  pdfTimeoutMs: number;
}

export function attachmentLimitsFromEnv(env: NodeJS.ProcessEnv = process.env): AttachmentLimits {
  return {
    maxBytes: envInteger(env, "OPENMAIL_ATTACHMENT_MAX_BYTES", 10 * 1024 * 1024, 64 * 1024, 50 * 1024 * 1024),
    pdfMaxPages: envInteger(env, "OPENMAIL_PDF_MAX_PAGES", 100, 1, 2_000),
    pdfTimeoutMs: envInteger(env, "OPENMAIL_PDF_TIMEOUT_MS", 10_000, 1_000, 60_000),
  };
}
