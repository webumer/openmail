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
