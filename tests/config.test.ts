import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config/index.js";
import { MailError } from "../src/errors.js";

const examplePath = fileURLToPath(new URL("../config.example.toml", import.meta.url));

describe("config", () => {
  it("loads the example file with placeholders and no secrets", () => {
    const config = loadConfig(examplePath);
    expect(config.allowInsecureLocalhost).toBe(false);
    expect(config.server).toEqual({ host: "127.0.0.1", port: 8080 });
    expect(config.accounts).toEqual([
      {
        id: "work",
        label: "Work",
        email: "you@example.com",
        preset: "migadu",
        passwordEnv: "OPENMAIL_ACCT_WORK_PASSWORD",
      },
    ]);
    const raw = readFileSync(examplePath, "utf8");
    expect(raw).not.toMatch(/^\s*password\s*=/m);
    expect(raw).toContain('password_env = "OPENMAIL_ACCT_WORK_PASSWORD"');
  });

  it("rejects an inline password without echoing the value", () => {
    const toml = `
      [[accounts]]
      id = "work"
      label = "Work"
      email = "you@example.com"
      preset = "migadu"
      password_env = "OPENMAIL_ACCT_WORK_PASSWORD"
      password = "super-secret-value"
    `;
    expect(() => parseToml(toml)).toThrow(MailError);
    try {
      parseToml(toml);
    } catch (err) {
      expect(err).toBeInstanceOf(MailError);
      expect((err as MailError).message).toMatch(/password/i);
      expect((err as MailError).message).not.toContain("super-secret-value");
    }
  });

  it("requires custom hosts and rejects preset overrides and duplicate ids", () => {
    expect(() => parseToml(`
      [[accounts]]
      id = "custom-example"
      label = "Custom"
      email = "person@example.com"
      preset = "custom"
      password_env = "OPENMAIL_ACCT_CUSTOM_PASSWORD"
    `)).toThrow(/imap_host/);

    expect(() => parseToml(`
      [[accounts]]
      id = "work"
      label = "Work"
      email = "you@example.com"
      preset = "migadu"
      password_env = "OPENMAIL_ACCT_WORK_PASSWORD"
      imap_host = "imap.example.com"
    `)).toThrow(/preset custom/);

    expect(() => parseToml(`
      [[accounts]]
      id = "work"
      label = "Work"
      email = "you@example.com"
      preset = "fastmail"
      password_env = "OPENMAIL_ACCT_WORK_PASSWORD"
      zoho_region = "eu"
    `)).toThrow(/zoho_region/);

    expect(() => parseToml(`
      [[accounts]]
      id = "work"
      label = "One"
      email = "you@example.com"
      preset = "migadu"
      password_env = "OPENMAIL_ACCT_WORK_PASSWORD"

      [[accounts]]
      id = "work"
      label = "Two"
      email = "other@example.com"
      preset = "fastmail"
      password_env = "OPENMAIL_ACCT_OTHER_PASSWORD"
    `)).toThrow(/Duplicate account id work/);
  });

  it("accepts a Zoho region and a custom account", () => {
    const config = parseToml(`
      allow_insecure_localhost = true

      [[accounts]]
      id = "eu"
      label = "EU"
      email = "person@example.com"
      preset = "zoho"
      zoho_region = "eu"
      password_env = "OPENMAIL_ACCT_EU_PASSWORD"

      [[accounts]]
      id = "custom-example"
      label = "Custom"
      email = "other@example.com"
      preset = "custom"
      password_env = "OPENMAIL_ACCT_CUSTOM_PASSWORD"
      imap_host = "imap.example.com"
      imap_port = 993
      smtp_host = "smtp.example.com"
      smtp_port = 587
      smtp_secure = false
      smtp_starttls = true
    `);
    expect(config.allowInsecureLocalhost).toBe(true);
    expect(config.accounts[0]).toMatchObject({ preset: "zoho", zohoRegion: "eu" });
    expect(config.accounts[1]).toMatchObject({
      preset: "custom",
      imapHost: "imap.example.com",
      imapPort: 993,
      smtpPort: 587,
      smtpSecure: false,
      smtpStarttls: true,
    });
  });

  it("rejects a missing file", () => {
    expect(() => loadConfig(join(tmpdir(), "openmail-missing-config.toml"))).toThrow(MailError);
  });
});

function parseToml(toml: string) {
  const dir = mkdtempSync(join(tmpdir(), "openmail-config-"));
  const path = join(dir, "config.toml");
  writeFileSync(path, toml);
  return loadConfig(path);
}
