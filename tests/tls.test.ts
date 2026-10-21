import { describe, expect, it } from "vitest";
import { MailError } from "../src/errors.js";
import { buildImapConnectOptions } from "../src/mail/tls.js";
import { account } from "./fixtures.js";

describe("IMAP transport policy", () => {
  it("keeps certificate verification on for implicit TLS", () => {
    const options = buildImapConnectOptions(account);
    expect(options.tls.rejectUnauthorized).toBe(true);
    expect(options.secure).toBe(true);
    expect(options.logger).toBe(false);
    expect(options.logRaw).toBe(false);
    expect(options.auth).toEqual({ user: "you@example.com", pass: account.password });
    expect(options.doSTARTTLS).toBeUndefined();
  });

  it("allows cleartext only for loopback when the flag is set", () => {
    const local = buildImapConnectOptions({
      ...account,
      allowInsecureLocalhost: true,
      imap: { host: "127.0.0.1", port: 3143, secure: false },
    });
    expect(local.secure).toBe(false);
    expect(local.doSTARTTLS).toBe(false);
    expect(local.tls.rejectUnauthorized).toBe(true);

    expect(buildImapConnectOptions({
      ...account,
      allowInsecureLocalhost: true,
      imap: { host: "localhost", port: 3143, secure: false },
    }).secure).toBe(false);
    expect(buildImapConnectOptions({
      ...account,
      allowInsecureLocalhost: true,
      imap: { host: "[::1]", port: 3143, secure: false },
    }).host).toBe("[::1]");
  });

  it("refuses cleartext for remote hosts and for loopback without the flag", () => {
    expect(() => buildImapConnectOptions({
      ...account,
      imap: { host: "imap.example.com", port: 143, secure: false },
    })).toThrow(MailError);
    expect(() => buildImapConnectOptions({
      ...account,
      allowInsecureLocalhost: false,
      imap: { host: "127.0.0.1", port: 143, secure: false },
    })).toThrow(/allow_insecure_localhost/);
    expect(() => buildImapConnectOptions({
      ...account,
      allowInsecureLocalhost: true,
      imap: { host: "localhost.example.com", port: 143, secure: false },
    })).toThrow(MailError);
  });
});
