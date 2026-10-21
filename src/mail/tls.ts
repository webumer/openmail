import { MailError } from "../errors.js";
import type { AccountCredentials } from "../store/types.js";
import type { ImapFlowOptions } from "imapflow";

const LOOPBACK = new Set(["localhost", "127.0.0.1", "::1"]);

export function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase().replace(/^\[|\]$/g, "");
  return LOOPBACK.has(normalized);
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
}

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
  };
  if (!account.imap.secure) options.doSTARTTLS = false;
  return options;
}
