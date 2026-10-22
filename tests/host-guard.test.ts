import { describe, expect, it } from "vitest";
import { checkCustomHost, isPrivateAddress } from "../src/web/host-guard.js";
import { isAllowlistedInsecureHost, parseInsecureImapHosts, assertImapTransportAllowed } from "../src/mail/tls.js";
import type { AccountCredentials } from "../src/store/types.js";

describe("custom host guard", () => {
  it("classifies private, loopback, link-local and mapped addresses", () => {
    for (const ip of ["10.0.0.1", "127.0.0.1", "169.254.169.254", "172.17.0.2", "192.168.1.7", "100.64.0.1", "0.0.0.0", "::1", "fd00::1", "fe80::1", "::ffff:10.0.0.1"]) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
    for (const ip of ["37.60.225.67", "1.1.1.1", "2606:4700:4700::1111"]) {
      expect(isPrivateAddress(ip), ip).toBe(false);
    }
  });

  it("rejects hosts that resolve to any private address and odd ports", async () => {
    const resolver = (map: Record<string, string[]>) => async (host: string) => map[host] ?? [];
    const base = { kind: "IMAP" as const, allowInsecureLocalhost: false };
    expect(await checkCustomHost({ ...base, host: "imap.example.com", port: 993 }, resolver({ "imap.example.com": ["93.184.216.34"] }))).toBeNull();
    expect(await checkCustomHost({ ...base, host: "evil.example", port: 993 }, resolver({ "evil.example": ["93.184.216.34", "10.0.0.5"] }))).toContain("public");
    expect(await checkCustomHost({ ...base, host: "openmail", port: 993 }, resolver({ openmail: ["172.18.0.3"] }))).toContain("public");
    expect(await checkCustomHost({ ...base, host: "nowhere.example", port: 993 }, resolver({}))).toContain("public internet");
    expect(await checkCustomHost({ ...base, host: "1.1.1.1", port: 8080 }, resolver({}))).toContain("port");
    expect(await checkCustomHost({ ...base, host: "localhost", port: 13143 }, resolver({}))).toContain("port");
    expect(await checkCustomHost({ ...base, host: "localhost", port: 13143, allowInsecureLocalhost: true }, resolver({}))).toBeNull();
  });
});

describe("plain IMAP allowlist", () => {
  const account = (host: string, list?: string[]): AccountCredentials => ({
    id: "a",
    label: "a",
    email: "a@example.com",
    preset: "custom",
    username: "a",
    password: "p",
    imap: { host, port: 3143, secure: false },
    smtp: { host, port: 3025, secure: false, starttls: false },
    allowInsecureLocalhost: false,
    sendEnabled: false,
    smtpAuth: { user: "a", pass: "p" },
    autoSavesSent: false,
    ...(list ? { insecureImapHosts: list } : {}),
  });

  it("parses exact hostnames only and allows plain IMAP just for them", () => {
    expect(parseInsecureImapHosts(" demo-mail , *.evil, bad host,Demo-Two ")).toEqual(["demo-mail", "demo-two"]);
    expect(isAllowlistedInsecureHost("DEMO-MAIL", ["demo-mail"])).toBe(true);
    expect(isAllowlistedInsecureHost("demo-mail.evil.example", ["demo-mail"])).toBe(false);
    expect(() => assertImapTransportAllowed(account("demo-mail", ["demo-mail"]))).not.toThrow();
    expect(() => assertImapTransportAllowed(account("imap.example.com", ["demo-mail"]))).toThrow(/Plain IMAP/);
    expect(() => assertImapTransportAllowed(account("demo-mail"))).toThrow(/Plain IMAP/);
  });
});
