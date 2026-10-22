import { MailError } from "../errors.js";
import type { AccountCredentials } from "../store/types.js";
import type { ImapFlowOptions } from "imapflow";

const LOOPBACK = new Set(["localhost", "127.0.0.1", "::1"]);

export function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase().replace(/^\[|\]$/g, "");
  return LOOPBACK.has(normalized);
}

/** Exact, case-insensitive hostname match. No wildcards, no IP ranges. */
export function isAllowlistedInsecureHost(host: string, allowlist: readonly string[] | undefined): boolean {
  if (!allowlist || allowlist.length === 0) return false;
  const normalized = host.trim().toLowerCase();
  return allowlist.some((entry) => entry.trim().toLowerCase() === normalized && normalized !== "");
}

/** Parses a comma-separated list of exact hostnames. No wildcards, no IPs with ports. */
export function parseInsecureHostList(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((part) => part.trim().toLowerCase())
    .filter((part) => /^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$/.test(part));
}

/** Parses OPENMAIL_INSECURE_IMAP_HOSTS (comma-separated exact hostnames). */
export function parseInsecureImapHosts(raw: string | undefined): string[] {
  return parseInsecureHostList(raw);
}

/** Parses OPENMAIL_INSECURE_SMTP_HOSTS the same way as the IMAP allowlist. */
export function parseInsecureSmtpHosts(raw: string | undefined): string[] {
  return parseInsecureHostList(raw);
}

/**
 * Implicit TLS is the normal path. Cleartext IMAP is allowed only for a
 * loopback host when `allow_insecure_localhost` is set (local test servers).
 * Certificate verification is not a parameter: callers always pass
 * `rejectUnauthorized: true` and this function never returns a false flag.
 */
export function assertImapTransportAllowed(account: AccountCredentials): void {
  if (!account.imap.host || account.imap.host.trim() === "") {
    throw new MailError("insecure_transport", "IMAP host is required");
  }
  if (account.imap.secure) return;
  if (account.allowInsecureLocalhost && isLoopbackHost(account.imap.host)) return;
  if (isAllowlistedInsecureHost(account.imap.host, account.insecureImapHosts)) return;
  throw new MailError(
    "insecure_transport",
    "Plain IMAP is allowed only for localhost when allow_insecure_localhost is set",
  );
}

export interface ImapConnectOptions extends ImapFlowOptions {
  host: string;
  port: number;
  secure: boolean;
  auth: { user: string; pass: string };
  tls: { rejectUnauthorized: true };
  logger: false;
  logRaw: false;
  emitLogs: false;
  servername?: string;
}

/** A slow or silent server must not hold a request (and its memory) for minutes. */
export const IMAP_CONNECTION_TIMEOUT_MS = 15_000;
export const IMAP_GREETING_TIMEOUT_MS = 15_000;
export const IMAP_SOCKET_TIMEOUT_MS = 60_000;

export function buildImapConnectOptions(account: AccountCredentials): ImapConnectOptions {
  assertImapTransportAllowed(account);
  const options: ImapConnectOptions = {
    host: account.imap.host,
    port: account.imap.port,
    secure: account.imap.secure,
    auth: { user: account.username, pass: account.password },
    tls: { rejectUnauthorized: true },
    logger: false,
    logRaw: false,
    emitLogs: false,
    disableAutoIdle: true,
    connectionTimeout: IMAP_CONNECTION_TIMEOUT_MS,
    greetingTimeout: IMAP_GREETING_TIMEOUT_MS,
    socketTimeout: IMAP_SOCKET_TIMEOUT_MS,
  };
  if (!account.imap.secure) options.doSTARTTLS = false;
  return options;
}

export const SMTP_PORTS = [465, 587, 2525] as const;

export interface SmtpConnectOptions {
  host: string;
  port: number;
  secure: boolean;
  requireTLS: boolean;
  ignoreTLS: boolean;
  auth: { user: string; pass: string };
  logger: false;
  debug: false;
  connectionTimeout: number;
  greetingTimeout: number;
  socketTimeout: number;
  tls: { rejectUnauthorized: true; servername?: string };
}

/**
 * Port 465 is implicit TLS. 587 and 2525 require STARTTLS. Any other port is
 * plain SMTP, and only for loopback (tests) or an exact allowlisted hostname.
 * `rejectUnauthorized` is always true; it is not a parameter.
 */
export function buildSmtpConnectOptions(
  account: AccountCredentials,
  target?: { host: string; servername?: string },
): SmtpConnectOptions {
  assertSmtpTransportAllowed(account);
  const mode = smtpMode(account);
  const options: SmtpConnectOptions = {
    host: target?.host ?? account.smtp.host,
    port: account.smtp.port,
    secure: mode === "implicit",
    requireTLS: mode === "starttls",
    ignoreTLS: mode === "plain",
    auth: { user: account.smtpAuth.user, pass: account.smtpAuth.pass },
    logger: false,
    debug: false,
    connectionTimeout: IMAP_CONNECTION_TIMEOUT_MS,
    greetingTimeout: IMAP_GREETING_TIMEOUT_MS,
    socketTimeout: IMAP_SOCKET_TIMEOUT_MS,
    tls: { rejectUnauthorized: true },
  };
  if (target?.servername) options.tls.servername = target.servername;
  return options;
}

export function assertSmtpTransportAllowed(account: AccountCredentials): void {
  if (!account.smtp.host || account.smtp.host.trim() === "") {
    throw new MailError("insecure_transport", "SMTP host is required");
  }
  if (smtpMode(account) === "plain" && !plainSmtpAllowed(account)) {
    throw new MailError(
      "insecure_transport",
      "Plain SMTP is allowed only for localhost when allow_insecure_localhost is set, or for an operator-listed host",
    );
  }
}

function smtpMode(account: AccountCredentials): "implicit" | "starttls" | "plain" {
  const port = account.smtp.port;
  const exception = plainSmtpAllowed(account);
  if (port === 465 && !(exception && !account.smtp.secure && !account.smtp.starttls)) return "implicit";
  if ((port === 587 || port === 2525) && !(exception && !account.smtp.secure && !account.smtp.starttls)) return "starttls";
  if (exception) return "plain";
  return "plain";
}

function plainSmtpAllowed(account: AccountCredentials): boolean {
  return (
    (account.allowInsecureLocalhost && isLoopbackHost(account.smtp.host)) ||
    isAllowlistedInsecureHost(account.smtp.host, account.insecureSmtpHosts)
  );
}
