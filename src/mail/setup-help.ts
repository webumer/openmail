import { failureCategory, type FailureCategory } from "../errors.js";
import type { ProviderPreset } from "./presets.js";

export const PROVIDER_HINTS: Record<ProviderPreset, string> = {
  gmail: "Gmail: enable 2-Step Verification and create an app password. IMAP is on by default for personal Gmail; Workspace admins may disable it.",
  icloud: "iCloud: create an app-specific password at account.apple.com. Use your full iCloud address as the username.",
  zoho: "Zoho: enable IMAP access in Zoho Mail settings; use an app password with 2FA. Choose the matching region: com, eu or in.",
  fastmail: "Fastmail: create an app password with IMAP and SMTP access.",
  migadu: "Migadu: use your mailbox password.",
  custom: "Yahoo: imap.mail.yahoo.com:993 TLS and smtp.mail.yahoo.com:465 TLS; an app password is needed. Outlook / Microsoft 365: outlook.office365.com:993 TLS and smtp.office365.com:587 STARTTLS. Microsoft has turned off password sign-in for most accounts, so even the right password may fail.",
};

const HELP: Record<FailureCategory, string> = {
  auth_failed: "Sign-in failed. Check the username and mailbox password, or create an app password with your provider.",
  timeout: "The server took too long to respond. Check the port and TLS settings, then try again.",
  tls: "A secure connection could not be verified. Check the port and TLS settings or contact your provider; certificate checks must stay on.",
  host_not_found: "The server address could not be resolved. Check the server name and try again.",
  connection_refused: "The connection was refused or interrupted. Check the server name, port and your provider's mail access settings.",
  imap_disabled: "Your provider requires an app password, web sign-in or permission to use mail apps. Enable IMAP access if available; password sign-in may be disabled by your provider.",
  host_not_allowed: "Use a public mail server address and TLS on a supported port.",
  unknown: "The connection failed. Check the server, port, TLS, username and password, then try again.",
};

export function setupFailureMessage(part: "IMAP" | "SMTP", err: unknown, preset: ProviderPreset): string {
  return `${part}: ${HELP[failureCategory(err)]} ${PROVIDER_HINTS[preset]}`;
}
