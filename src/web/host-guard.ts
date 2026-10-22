import { isIP } from "node:net";
import { defaultResolver, isPrivateAddress, type Resolver } from "../mail/address-guard.js";

export { isPrivateAddress, type Resolver };

/**
 * Custom mailbox hosts come from strangers. Without a guard the "test
 * connection" button would let anyone probe the server's private network.
 * Presets point at fixed public provider hosts and skip this check.
 */
export const ALLOWED_IMAP_PORTS: readonly number[] = [143, 993];
export const ALLOWED_SMTP_PORTS: readonly number[] = [25, 465, 587, 2525];

const LOOPBACK_NAMES = new Set(["localhost", "127.0.0.1", "::1"]);

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
  // One message for "bad host" so an attacker cannot tell NXDOMAIN from
  // "resolved to a private address" (which would map internal Docker names).
  const refused = `${input.kind} host must be a public internet address`;
  let addresses: string[];
  try {
    addresses = isIP(host) ? [host] : await resolve(host);
  } catch {
    return refused;
  }
  if (addresses.length === 0 || addresses.some(isPrivateAddress)) return refused;
  return null;
}
