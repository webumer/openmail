import { describe, expect, it } from "vitest";
import { MailError } from "../src/errors.js";
import { resolveEndpoints, type ProviderPreset } from "../src/mail/presets.js";

describe("provider presets", () => {
  it("resolves the fixed TLS presets", () => {
    expect(resolveEndpoints({ preset: "migadu" })).toEqual({
      imap: { host: "imap.migadu.com", port: 993, secure: true },
      smtp: { host: "smtp.migadu.com", port: 465, secure: true, starttls: false },
    });
    expect(resolveEndpoints({ preset: "fastmail" }).imap.host).toBe("imap.fastmail.com");
    expect(resolveEndpoints({ preset: "fastmail" }).smtp).toMatchObject({ host: "smtp.fastmail.com", port: 465, secure: true });
  });

  it("uses Zoho regional hosts and defaults to .com", () => {
    expect(resolveEndpoints({ preset: "zoho" }).imap.host).toBe("imap.zoho.com");
    expect(resolveEndpoints({ preset: "zoho", zohoRegion: "eu" })).toEqual({
      imap: { host: "imap.zoho.eu", port: 993, secure: true },
      smtp: { host: "smtp.zoho.eu", port: 465, secure: true, starttls: false },
    });
    expect(resolveEndpoints({ preset: "zoho", zohoRegion: "in" }).imap.host).toBe("imap.zoho.in");
    expect(resolveEndpoints({ preset: "zoho", zohoRegion: "in" }).smtp.host).toBe("smtp.zoho.in");
  });

  it("uses STARTTLS for iCloud SMTP", () => {
    expect(resolveEndpoints({ preset: "icloud" })).toEqual({
      imap: { host: "imap.mail.me.com", port: 993, secure: true },
      smtp: { host: "smtp.mail.me.com", port: 587, secure: false, starttls: true },
    });
  });

  it("requires explicit hosts for custom and rejects an unknown preset", () => {
    expect(resolveEndpoints({
      preset: "custom",
      imapHost: "imap.example.com",
      imapPort: 993,
      smtpHost: "smtp.example.com",
      smtpPort: 465,
    })).toEqual({
      imap: { host: "imap.example.com", port: 993, secure: true },
      smtp: { host: "smtp.example.com", port: 465, secure: true, starttls: false },
    });
    expect(() => resolveEndpoints({ preset: "custom" })).toThrow(MailError);
    expect(() => resolveEndpoints({ preset: "nope" as ProviderPreset })).toThrow(/Unknown provider preset/);
  });
});
