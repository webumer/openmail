import { z } from "zod";
import { PROVIDER_PRESETS, ZOHO_REGIONS, resolveEndpoints, type ProviderPreset, type ZohoRegion } from "../mail/presets.js";

const EMAIL = "Enter a valid email address";
const USER_PASSWORD = "Password must be 10 to 200 characters";

const emailField = z.string().trim().max(254, EMAIL).toLowerCase().pipe(z.email(EMAIL));

export const signupSchema = z.object({
  email: emailField,
  password: z.string().min(10, USER_PASSWORD).max(200, USER_PASSWORD),
});

export const loginSchema = z.object({
  email: emailField,
  password: z.string().min(1, "Email or password is incorrect").max(200, "Email or password is incorrect"),
});

export const keySchema = z.object({
  name: z.string().trim().min(1, "Key name is required").max(200, "Key name must be 1 to 200 characters"),
});

const accountSchema = z
  .object({
    name: z.string().trim().min(1, "Account name is required").max(200, "Account name must be 1 to 200 characters"),
    email: emailField,
    username: z.string().trim().max(200, "Username must be at most 200 characters"),
    password: z
      .string()
      .min(1, "Mailbox password is required")
      .max(1000, "Mailbox password must be at most 1000 characters"),
    preset: z.enum(PROVIDER_PRESETS, "Choose a provider preset"),
    zoho_region: z.string().trim(),
    imap_host: z.string().trim(),
    imap_port: z.string().trim(),
    imap_secure: z.string(),
    smtp_host: z.string().trim(),
    smtp_port: z.string().trim(),
    smtp_secure: z.string(),
    smtp_starttls: z.string(),
  })
  .superRefine((value, ctx) => {
    if (value.preset === "zoho" && value.zoho_region && !isZohoRegion(value.zoho_region)) {
      ctx.addIssue({ code: "custom", path: ["zoho_region"], message: "Choose a Zoho region" });
    }
    if (value.preset !== "custom") return;
    if (!hostOk(value.imap_host)) {
      ctx.addIssue({ code: "custom", path: ["imap_host"], message: "IMAP host is required" });
    }
    if (portNumber(value.imap_port) === undefined) {
      ctx.addIssue({ code: "custom", path: ["imap_port"], message: "IMAP port must be a whole number from 1 to 65535" });
    }
    if (!hostOk(value.smtp_host)) {
      ctx.addIssue({ code: "custom", path: ["smtp_host"], message: "SMTP host is required" });
    }
    if (portNumber(value.smtp_port) === undefined) {
      ctx.addIssue({ code: "custom", path: ["smtp_port"], message: "SMTP port must be a whole number from 1 to 65535" });
    }
    if (value.smtp_secure === "on" && value.smtp_starttls === "on") {
      ctx.addIssue({
        code: "custom",
        path: ["smtp_starttls"],
        message: "Choose either implicit TLS or STARTTLS for SMTP, not both",
      });
    }
  });

export interface AccountDraft {
  name: string;
  email: string;
  username: string;
  preset: ProviderPreset;
  zohoRegion: ZohoRegion;
  imapHost: string;
  imapPort: string;
  imapSecure: boolean;
  smtpHost: string;
  smtpPort: string;
  smtpSecure: boolean;
  smtpStarttls: boolean;
}

export interface ParsedAccount {
  name: string;
  email: string;
  username: string;
  preset: ProviderPreset;
  password: string;
  zohoRegion?: ZohoRegion;
  imapHost?: string;
  imapPort?: number;
  imapSecure?: boolean;
  smtpHost?: string;
  smtpPort?: number;
  smtpSecure?: boolean;
  smtpStarttls?: boolean;
}

export interface AccountParse {
  draft: AccountDraft;
  errors: string[];
  account?: ParsedAccount;
}

export function emptyAccountDraft(): AccountDraft {
  return draftFromEndpoints("migadu", "com", {
    name: "",
    email: "",
    username: "",
  });
}

export function parseSignup(raw: Record<string, string>): { errors: string[]; email?: string; password?: string } {
  return parseFields(signupSchema, raw);
}

export function parseLogin(raw: Record<string, string>): { errors: string[]; email?: string; password?: string } {
  return parseFields(loginSchema, raw);
}

export function parseKeyName(raw: Record<string, string>): { errors: string[]; name?: string } {
  const parsed = keySchema.safeParse({ name: raw.name ?? "" });
  if (!parsed.success) return { errors: issues(parsed.error) };
  return { errors: [], name: parsed.data.name };
}

export function parseAccountForm(raw: Record<string, string>): AccountParse {
  const draft = draftFromRaw(raw);
  const parsed = accountSchema.safeParse({
    name: raw.name ?? "",
    email: raw.email ?? "",
    username: raw.username ?? "",
    password: raw.password ?? "",
    preset: raw.preset ?? "",
    zoho_region: raw.zoho_region ?? "",
    imap_host: raw.imap_host ?? "",
    imap_port: raw.imap_port ?? "",
    imap_secure: raw.imap_secure ?? "",
    smtp_host: raw.smtp_host ?? "",
    smtp_port: raw.smtp_port ?? "",
    smtp_secure: raw.smtp_secure ?? "",
    smtp_starttls: raw.smtp_starttls ?? "",
  });
  if (!parsed.success) return { draft, errors: issues(parsed.error) };
  const data = parsed.data;
  const username = data.username || data.email;
  const account: ParsedAccount = {
    name: data.name,
    email: data.email,
    username,
    preset: data.preset,
    password: data.password,
  };
  if (data.preset === "zoho") {
    const region = asZohoRegion(data.zoho_region);
    if (region) account.zohoRegion = region;
  }
  if (data.preset === "custom") {
    const imapPort = portNumber(data.imap_port);
    const smtpPort = portNumber(data.smtp_port);
    if (imapPort === undefined || smtpPort === undefined) {
      return { draft, errors: ["IMAP port must be a whole number from 1 to 65535"] };
    }
    account.imapHost = data.imap_host;
    account.imapPort = imapPort;
    account.imapSecure = data.imap_secure === "on";
    account.smtpHost = data.smtp_host;
    account.smtpPort = smtpPort;
    account.smtpSecure = data.smtp_secure === "on";
    account.smtpStarttls = data.smtp_starttls === "on";
  }
  return { draft, errors: [], account };
}

function parseFields(
  schema: typeof signupSchema | typeof loginSchema,
  raw: Record<string, string>,
): { errors: string[]; email?: string; password?: string } {
  const parsed = schema.safeParse({ email: raw.email ?? "", password: raw.password ?? "" });
  if (!parsed.success) return { errors: issues(parsed.error) };
  return { errors: [], email: parsed.data.email, password: parsed.data.password };
}

function issues(error: z.ZodError): string[] {
  const messages: string[] = [];
  for (const issue of error.issues) {
    if (!messages.includes(issue.message)) messages.push(issue.message);
  }
  return messages.length > 0 ? messages : ["Check the form and try again"];
}

function draftFromRaw(raw: Record<string, string>): AccountDraft {
  const preset = isPreset(raw.preset) ? raw.preset : "migadu";
  const zohoRegion = asZohoRegion(raw.zoho_region ?? "") ?? "com";
  const identity = {
    name: clip(raw.name ?? ""),
    email: clip((raw.email ?? "").trim()),
    username: clip(raw.username ?? ""),
  };
  if (preset === "custom") {
    return {
      ...identity,
      preset,
      zohoRegion,
      imapHost: clip(raw.imap_host ?? ""),
      imapPort: clip(raw.imap_port ?? "", 5),
      imapSecure: raw.imap_secure === "on",
      smtpHost: clip(raw.smtp_host ?? ""),
      smtpPort: clip(raw.smtp_port ?? "", 5),
      smtpSecure: raw.smtp_secure === "on",
      smtpStarttls: raw.smtp_starttls === "on",
    };
  }
  return draftFromEndpoints(preset, zohoRegion, identity);
}

function draftFromEndpoints(
  preset: Exclude<ProviderPreset, "custom">,
  zohoRegion: ZohoRegion,
  identity: { name: string; email: string; username: string },
): AccountDraft {
  const endpoints = resolveEndpoints({
    preset,
    ...(preset === "zoho" ? { zohoRegion } : {}),
  });
  return {
    ...identity,
    preset,
    zohoRegion,
    imapHost: endpoints.imap.host,
    imapPort: String(endpoints.imap.port),
    imapSecure: endpoints.imap.secure,
    smtpHost: endpoints.smtp.host,
    smtpPort: String(endpoints.smtp.port),
    smtpSecure: endpoints.smtp.secure,
    smtpStarttls: endpoints.smtp.starttls,
  };
}

function isPreset(value: string | undefined): value is ProviderPreset {
  return typeof value === "string" && (PROVIDER_PRESETS as readonly string[]).includes(value);
}

function isZohoRegion(value: string): value is ZohoRegion {
  return (ZOHO_REGIONS as readonly string[]).includes(value);
}

function asZohoRegion(value: string): ZohoRegion | undefined {
  return isZohoRegion(value) ? value : undefined;
}

function hostOk(value: string): boolean {
  if (value.length < 1 || value.length > 253) return false;
  if (/[\s/\\@]/.test(value)) return false;
  return !/[\u0000-\u001f\u007f]/.test(value);
}

function portNumber(value: string): number | undefined {
  if (!/^\d{1,5}$/.test(value)) return undefined;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return undefined;
  return port;
}

function clip(value: string, max = 200): string {
  const trimmed = value.trim();
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed;
}
