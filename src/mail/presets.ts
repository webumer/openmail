import { MailError } from "../errors.js";

export const PROVIDER_PRESETS = ["migadu", "fastmail", "zoho", "icloud", "custom"] as const;
export type ProviderPreset = (typeof PROVIDER_PRESETS)[number];

export const ZOHO_REGIONS = ["com", "eu", "in"] as const;
export type ZohoRegion = (typeof ZOHO_REGIONS)[number];

export interface ImapEndpoint {
  host: string;
  port: number;
  /** Implicit TLS on connect. False only for the loopback plain-IMAP test path. */
  secure: boolean;
}

export interface SmtpEndpoint {
  host: string;
  port: number;
  /** Implicit TLS (port 465). False when the preset uses STARTTLS. */
  secure: boolean;
  /** Upgrade with STARTTLS. Certificate verification still applies. */
  starttls: boolean;
}

export interface EndpointInput {
  preset: ProviderPreset;
  zohoRegion?: ZohoRegion;
  imapHost?: string;
  imapPort?: number;
  imapSecure?: boolean;
  smtpHost?: string;
  smtpPort?: number;
  smtpSecure?: boolean;
  smtpStarttls?: boolean;
}

const TLS = true;

const FIXED: Record<Exclude<ProviderPreset, "custom" | "zoho">, { imap: ImapEndpoint; smtp: SmtpEndpoint }> = {
  migadu: {
    imap: { host: "imap.migadu.com", port: 993, secure: TLS },
    smtp: { host: "smtp.migadu.com", port: 465, secure: TLS, starttls: false },
  },
  fastmail: {
    imap: { host: "imap.fastmail.com", port: 993, secure: TLS },
    smtp: { host: "smtp.fastmail.com", port: 465, secure: TLS, starttls: false },
  },
  icloud: {
    imap: { host: "imap.mail.me.com", port: 993, secure: TLS },
    smtp: { host: "smtp.mail.me.com", port: 587, secure: false, starttls: true },
  },
};

export function zohoEndpoints(region: ZohoRegion = "com"): { imap: ImapEndpoint; smtp: SmtpEndpoint } {
  if (!ZOHO_REGIONS.includes(region)) {
    throw new MailError("config_error", `Unknown Zoho region "${region}"`);
  }
  return {
    imap: { host: `imap.zoho.${region}`, port: 993, secure: TLS },
    smtp: { host: `smtp.zoho.${region}`, port: 465, secure: TLS, starttls: false },
  };
}

export function resolveEndpoints(input: EndpointInput): { imap: ImapEndpoint; smtp: SmtpEndpoint } {
  switch (input.preset) {
    case "migadu":
    case "fastmail":
    case "icloud":
      return FIXED[input.preset];
    case "zoho":
      return zohoEndpoints(input.zohoRegion ?? "com");
    case "custom":
      return customEndpoints(input);
    default: {
      const unknown: never = input.preset;
      throw new MailError("config_error", `Unknown provider preset "${String(unknown)}"`);
    }
  }
}

function customEndpoints(input: EndpointInput): { imap: ImapEndpoint; smtp: SmtpEndpoint } {
  if (!input.imapHost || input.imapPort === undefined || !input.smtpHost || input.smtpPort === undefined) {
    throw new MailError("config_error", "Custom preset requires imap_host, imap_port, smtp_host, and smtp_port");
  }
  return {
    imap: {
      host: input.imapHost,
      port: input.imapPort,
      secure: input.imapSecure ?? true,
    },
    smtp: {
      host: input.smtpHost,
      port: input.smtpPort,
      secure: input.smtpSecure ?? true,
      starttls: input.smtpStarttls ?? false,
    },
  };
}
