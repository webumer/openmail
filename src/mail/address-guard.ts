import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import { MailError } from "../errors.js";
import type { AccountCredentials } from "../store/types.js";
import { isAllowlistedInsecureHost, isLoopbackHost } from "./tls.js";

/**
 * Addresses a stranger's mailbox host must never point at: loopback, private
 * networks, link-local (cloud metadata at 169.254.169.254), CGNAT,
 * documentation, multicast and reserved ranges, plus IPv6 equivalents.
 */
// Separate lists: Node's BlockList matches IPv4 addresses against IPv6
// rules through the IPv4-mapped range, so mixing them gives false positives.
const PRIVATE = new BlockList();
const PRIVATE6 = new BlockList();
for (const [net, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  PRIVATE.addSubnet(net, prefix, "ipv4");
}
for (const [net, prefix] of [
  // Unspecified, loopback and the deprecated IPv4-compatible range.
  ["::", 96],
  // IPv4-mapped in hex form (::ffff:7f00:1). Dotted form is checked as IPv4.
  ["::ffff:0:0", 96],
  ["64:ff9b::", 96],
  ["64:ff9b:1::", 48],
  ["100::", 64],
  // Teredo and 6to4 can embed an arbitrary IPv4 address.
  ["2001::", 32],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["fc00::", 7],
  ["fe80::", 10],
  ["fec0::", 10],
  ["ff00::", 8],
] as const) {
  PRIVATE6.addSubnet(net, prefix, "ipv6");
}

export type Resolver = (host: string) => Promise<string[]>;

export const defaultResolver: Resolver = async (host) => {
  const results = await lookup(host, { all: true, verbatim: true });
  return results.map((entry) => entry.address);
};

/** True for anything that is not a routable public unicast address (and for non-IPs). */
export function isPrivateAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return PRIVATE.check(address, "ipv4");
  if (family === 6) {
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
    if (mapped?.[1]) return PRIVATE.check(mapped[1], "ipv4");
    return PRIVATE6.check(address, "ipv6");
  }
  return true;
}

export interface ConnectTarget {
  /** Address (or, for operator-trusted hosts, the name) the socket connects to. */
  host: string;
  /** TLS server name for SNI and certificate checks when `host` was pinned to an IP. */
  servername?: string;
}

/**
 * Resolves the IMAP host once, refuses private addresses, and pins the
 * connection to the address that was checked. Re-checking at connect time
 * (not only when the account was saved) closes the DNS-rebinding window:
 * a hostname that later resolves to 127.0.0.1 or 169.254.169.254 is refused,
 * and the socket cannot be redirected between the check and the connect.
 * TLS still verifies the certificate against the original hostname.
 *
 * Exceptions are operator-controlled only: loopback when
 * `allowInsecureLocalhost` is set (local tests) and exact hostnames on the
 * plain-IMAP allowlist (the internal reviewer demo mailbox).
 */
export async function resolveConnectTarget(
  account: AccountCredentials,
  resolve: Resolver = defaultResolver,
): Promise<ConnectTarget> {
  const raw = account.imap.host.trim();
  if (account.allowInsecureLocalhost && isLoopbackHost(raw)) return { host: raw };
  if (isAllowlistedInsecureHost(raw, account.insecureImapHosts)) return { host: raw };
  const host = raw.toLowerCase().replace(/^\[|\]$/g, "");
  if (isIP(host)) {
    if (isPrivateAddress(host)) throw blocked();
    return { host };
  }
  let addresses: string[];
  try {
    addresses = await resolve(host);
  } catch {
    throw new MailError("imap_error", "IMAP host could not be resolved");
  }
  if (addresses.length === 0) throw new MailError("imap_error", "IMAP host could not be resolved");
  if (addresses.some(isPrivateAddress)) throw blocked();
  const first = addresses[0] as string;
  return { host: first, servername: host };
}

function blocked(): MailError {
  return new MailError("blocked_host", "IMAP host must be a public internet address");
}
