import { isIP } from "node:net";
import { MailError } from "../errors.js";
import { defaultResolver, isPrivateAddress, type Resolver } from "../mail/address-guard.js";

export { isPrivateAddress, type Resolver };

/**
 * Custom mailbox hosts come from strangers. Without a guard the "test
 * connection" button would let anyone probe the server's private network.
 * Presets point at fixed public provider hosts and skip this check.
 */
export const ALLOWED_IMAP_PORTS: readonly number[] = [143, 993];
export const ALLOWED_SMTP_PORTS: readonly number[] = [465, 587, 2525];

const LOOPBACK_NAMES = new Set(["localhost", "127.0.0.1", "::1"]);

/**
 * Returns a safe error with its category, or null when the host is allowed.
 * Loopback is allowed only with allowInsecureLocalhost (local tests).
 */
export async function checkCustomHostFailure(
  input: { host: string; port: number; kind: "IMAP" | "SMTP"; allowInsecureLocalhost: boolean },
  resolve: Resolver = defaultResolver,
): Promise<MailError | null> {
  const host = input.host.trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (input.allowInsecureLocalhost && LOOPBACK_NAMES.has(host)) return null;
  const allowedPorts = input.kind === "IMAP" ? ALLOWED_IMAP_PORTS : ALLOWED_SMTP_PORTS;
  if (!allowedPorts.includes(input.port)) {
    return new MailError("blocked_host", `${input.kind} port must be one of ${allowedPorts.join(", ")}`, "host_not_allowed");
  }
  // Never include the queried name or resolved addresses in guard messages.
  // Keep DNS failures indistinguishable from private addresses, including in metrics.
  const refused = "Use a public mail server address";
  let addresses: string[];
  try {
    addresses = isIP(host) ? [host] : await resolve(host);
  } catch {
    return new MailError("blocked_host", refused, "host_not_allowed");
  }
  if (addresses.length === 0) return new MailError("blocked_host", refused, "host_not_allowed");
  if (addresses.some(isPrivateAddress)) return new MailError("blocked_host", refused, "host_not_allowed");
  return null;
}

/** Compatibility wrapper for callers that need only the safe guard message. */
export async function checkCustomHost(
  input: Parameters<typeof checkCustomHostFailure>[0],
  resolve: Resolver = defaultResolver,
): Promise<string | null> {
  return (await checkCustomHostFailure(input, resolve))?.message ?? null;
}
