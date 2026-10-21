import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";

/**
 * Custom mailbox hosts come from strangers. Without a guard the "test
 * connection" button would let anyone probe the server's private network.
 * Presets point at fixed public provider hosts and skip this check.
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
  ["::", 128],
  ["::1", 128],
  ["64:ff9b::", 96],
  ["100::", 64],
  ["2001:db8::", 32],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
] as const) {
  PRIVATE6.addSubnet(net, prefix, "ipv6");
}

export const ALLOWED_IMAP_PORTS: readonly number[] = [143, 993];
export const ALLOWED_SMTP_PORTS: readonly number[] = [25, 465, 587, 2525];

const LOOPBACK_NAMES = new Set(["localhost", "127.0.0.1", "::1"]);

export type Resolver = (host: string) => Promise<string[]>;

const defaultResolver: Resolver = async (host) => {
  const results = await lookup(host, { all: true, verbatim: true });
  return results.map((entry) => entry.address);
};

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

/**
 * Returns an error message for the user, or null when the host is allowed.
 * Loopback is allowed only with allowInsecureLocalhost (local tests).
 */
export async function checkCustomHost(
  input: { host: string; port: number; kind: "IMAP" | "SMTP"; allowInsecureLocalhost: boolean },
  resolve: Resolver = defaultResolver,
): Promise<string | null> {
  const host = input.host.trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (input.allowInsecureLocalhost && LOOPBACK_NAMES.has(host)) return null;
  const allowedPorts = input.kind === "IMAP" ? ALLOWED_IMAP_PORTS : ALLOWED_SMTP_PORTS;
  if (!allowedPorts.includes(input.port)) {
    return `${input.kind} port must be one of ${allowedPorts.join(", ")}`;
  }
  let addresses: string[];
  try {
    addresses = isIP(host) ? [host] : await resolve(host);
  } catch {
    return `${input.kind} host could not be resolved`;
  }
  if (addresses.length === 0) return `${input.kind} host could not be resolved`;
  if (addresses.some(isPrivateAddress)) {
    return `${input.kind} host must be a public internet address`;
  }
  return null;
}
