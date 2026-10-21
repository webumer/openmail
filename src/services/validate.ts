import { z } from "zod";
import { MailError } from "../errors.js";
import { PROVIDER_PRESETS, ZOHO_REGIONS, type ProviderPreset, type ZohoRegion } from "../mail/presets.js";

export function parseEmail(value: unknown): string {
  if (typeof value !== "string") throw new MailError("invalid_argument", "Email address is invalid");
  const parsed = z.email().safeParse(value.trim().toLowerCase());
  if (!parsed.success) throw new MailError("invalid_argument", "Email address is invalid");
  return parsed.data;
}

export function requireUserPassword(value: unknown): string {
  if (typeof value !== "string" || value.length < 10 || value.length > 200) {
    throw new MailError("invalid_argument", "Password must be 10 to 200 characters");
  }
  return value;
}

export function requireMailboxPassword(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 1000) {
    throw new MailError("invalid_argument", "Mailbox password is required");
  }
  return value;
}

export function requireLabel(value: unknown, label: string): string {
  if (typeof value !== "string") throw new MailError("invalid_argument", `${label} is required`);
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 200) {
    throw new MailError("invalid_argument", `${label} must be 1 to 200 characters`);
  }
  return trimmed;
}

export function requireId(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new MailError("invalid_argument", `${label} is required`);
  }
  return value.trim();
}

export function parsePreset(value: unknown): ProviderPreset {
  if (typeof value === "string" && (PROVIDER_PRESETS as readonly string[]).includes(value)) {
    return value as ProviderPreset;
  }
  throw new MailError("invalid_argument", "Unknown provider preset");
}

export function parseZohoRegion(value: unknown): ZohoRegion | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string" && (ZOHO_REGIONS as readonly string[]).includes(value)) {
    return value as ZohoRegion;
  }
  throw new MailError("invalid_argument", "Unknown Zoho region");
}
