import { z } from "zod";
import { MailError } from "../errors.js";
import { PROVIDER_PRESETS, ZOHO_REGIONS, type ProviderPreset, type ZohoRegion } from "../mail/presets.js";

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

const AccountSchema = z
  .object({
    id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/, "must be a short identifier"),
    label: z.string().min(1).max(200),
    email: z.email(),
    preset: z.enum(PROVIDER_PRESETS),
    password_env: z.string().regex(ENV_NAME, "must be an environment variable name"),
    username: z.string().min(1).optional(),
    zoho_region: z.enum(ZOHO_REGIONS).optional(),
    imap_host: z.string().min(1).optional(),
    imap_port: z.number().int().min(1).max(65535).optional(),
    imap_secure: z.boolean().optional(),
    smtp_host: z.string().min(1).optional(),
    smtp_port: z.number().int().min(1).max(65535).optional(),
    smtp_secure: z.boolean().optional(),
    smtp_starttls: z.boolean().optional(),
  })
  .strict()
  .superRefine((account, ctx) => {
    if (account.preset === "custom") {
      requireField(ctx, account.imap_host, "imap_host", "imap_host is required for preset custom");
      requireField(ctx, account.imap_port, "imap_port", "imap_port is required for preset custom");
      requireField(ctx, account.smtp_host, "smtp_host", "smtp_host is required for preset custom");
      requireField(ctx, account.smtp_port, "smtp_port", "smtp_port is required for preset custom");
      if (account.smtp_secure === true && account.smtp_starttls === true) {
        ctx.addIssue({
          code: "custom",
          path: ["smtp_starttls"],
          message: "smtp_secure and smtp_starttls cannot both be true",
        });
      }
    } else if (
      account.imap_host !== undefined ||
      account.imap_port !== undefined ||
      account.imap_secure !== undefined ||
      account.smtp_host !== undefined ||
      account.smtp_port !== undefined ||
      account.smtp_secure !== undefined ||
      account.smtp_starttls !== undefined
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["preset"],
        message: "host and port overrides are only valid for preset custom",
      });
    }
    if (account.zoho_region !== undefined && account.preset !== "zoho") {
      ctx.addIssue({
        code: "custom",
        path: ["zoho_region"],
        message: "zoho_region is only valid for preset zoho",
      });
    }
  });

const ConfigSchema = z
  .object({
    mode: z.enum(["single", "multi"]).default("multi"),
    server: z
      .object({
        host: z.string().min(1).default("127.0.0.1"),
        port: z.number().int().min(1).max(65535).default(8080),
      })
      .strict()
      .default({ host: "127.0.0.1", port: 8080 }),
    allow_insecure_localhost: z.boolean().default(false),
    accounts: z.array(AccountSchema).default([]),
  })
  .strict()
  .superRefine((config, ctx) => {
    const seen = new Set<string>();
    config.accounts.forEach((account, index) => {
      if (seen.has(account.id)) {
        ctx.addIssue({
          code: "custom",
          path: ["accounts", index, "id"],
          message: `Duplicate account id ${account.id}`,
        });
      }
      seen.add(account.id);
    });
  });

export type OpenMailMode = "single" | "multi";

export interface ServerConfig {
  host: string;
  port: number;
}

export interface AccountConfig {
  id: string;
  label: string;
  email: string;
  preset: ProviderPreset;
  passwordEnv: string;
  username?: string;
  zohoRegion?: ZohoRegion;
  imapHost?: string;
  imapPort?: number;
  imapSecure?: boolean;
  smtpHost?: string;
  smtpPort?: number;
  smtpSecure?: boolean;
  smtpStarttls?: boolean;
}

export interface AppConfig {
  mode: OpenMailMode;
  server: ServerConfig;
  allowInsecureLocalhost: boolean;
  accounts: AccountConfig[];
}

export function parseConfig(input: unknown): AppConfig {
  const result = ConfigSchema.safeParse(input);
  if (!result.success) {
    throw new MailError("config_error", formatIssues(result.error.issues));
  }
  return {
    mode: result.data.mode,
    server: { host: result.data.server.host, port: result.data.server.port },
    allowInsecureLocalhost: result.data.allow_insecure_localhost,
    accounts: result.data.accounts.map((account) => ({
      id: account.id,
      label: account.label,
      email: account.email,
      preset: account.preset,
      passwordEnv: account.password_env,
      ...(account.username !== undefined ? { username: account.username } : {}),
      ...(account.zoho_region !== undefined ? { zohoRegion: account.zoho_region } : {}),
      ...(account.imap_host !== undefined ? { imapHost: account.imap_host } : {}),
      ...(account.imap_port !== undefined ? { imapPort: account.imap_port } : {}),
      ...(account.imap_secure !== undefined ? { imapSecure: account.imap_secure } : {}),
      ...(account.smtp_host !== undefined ? { smtpHost: account.smtp_host } : {}),
      ...(account.smtp_port !== undefined ? { smtpPort: account.smtp_port } : {}),
      ...(account.smtp_secure !== undefined ? { smtpSecure: account.smtp_secure } : {}),
      ...(account.smtp_starttls !== undefined ? { smtpStarttls: account.smtp_starttls } : {}),
    })),
  };
}

function requireField(
  ctx: { addIssue(issue: { code: "custom"; path: string[]; message: string }): void },
  value: unknown,
  path: string,
  message: string,
): void {
  if (value === undefined) ctx.addIssue({ code: "custom", path: [path], message });
}

function formatIssues(issues: readonly { path: PropertyKey[]; message: string }[]): string {
  if (issues.length === 0) return "Invalid configuration";
  return issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.map(String).join(".") : "(root)";
      return `${path}: ${issue.message}`;
    })
    .join("; ");
}
