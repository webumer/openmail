import { describe, expect, it } from "vitest";
import { failureCategory, toMailError, toSmtpError } from "../src/errors.js";
import { testConnection } from "../src/services/mail-accounts.js";
import { PROVIDER_HINTS, setupFailureMessage } from "../src/mail/setup-help.js";
import { checkCustomHostFailure } from "../src/web/host-guard.js";
import { resolveHostTarget } from "../src/mail/address-guard.js";
import type { ImapGateway } from "../src/mail/imap-gateway.js";
import { account } from "./fixtures.js";

describe("safe connection failures", () => {
  it.each([
    [{ code: "ENOTFOUND" }, "host_not_found"], [{ code: "EAI_AGAIN" }, "host_not_found"],
    [{ code: "ETIMEDOUT" }, "timeout"], [{ code: "ESOCKETTIMEDOUT" }, "timeout"],
    [{ code: "ECONNREFUSED" }, "connection_refused"], [{ code: "ECONNRESET" }, "connection_refused"],
    [{ code: "ECONNECTION" }, "connection_refused"], [{ code: "ERR_TLS_CERT_ALTNAME_INVALID" }, "tls"],
    [{ code: "DEPTH_ZERO_SELF_SIGNED_CERT" }, "tls"], [{ authenticationFailed: true }, "auth_failed"],
    [{ serverResponseCode: "AUTHENTICATIONFAILED" }, "auth_failed"], [{ code: "EAUTH" }, "auth_failed"],
    [{ responseText: "Application-specific password required" }, "imap_disabled"],
    [{ responseText: "Web login required" }, "imap_disabled"], [{ responseText: "IMAP access is disabled" }, "imap_disabled"],
    [{ response: "Basic authentication is not supported" }, "imap_disabled"],
    [{ response: "SmtpClientAuthentication is disabled for the Tenant" }, "imap_disabled"],
    [{ code: "blocked_host" }, "host_not_allowed"], [{ code: "insecure_transport" }, "host_not_allowed"],
    [new Error("something happened"), "unknown"],
  ])("classifies raw fields: %o", (raw, category) => {
    expect(failureCategory(raw)).toBe(category);
    expect(toMailError(raw).category).toBe(category);
    expect(toSmtpError(raw).category).toBe(category);
  });

  it("keeps raw server text and identifiers out of guidance", async () => {
    const err = Object.assign(new Error(`private.host private@example.com ${account.password}`), { code: "EAUTH" });
    const message = setupFailureMessage("SMTP", err, "gmail");
    expect(message).toContain("SMTP: Sign-in failed");
    expect(message).toContain("2-Step Verification");
    for (const value of ["private.host", "private@example.com", account.password]) expect(message).not.toContain(value);
    const imap = { withClient: async () => undefined } as unknown as ImapGateway;
    await expect(testConnection(account, imap, { verify: async () => { throw err; }, send: async () => { throw new Error("must not send"); } }))
      .rejects.toMatchObject({ part: "SMTP", code: "smtp_error", category: "auth_failed" });
    expect(PROVIDER_HINTS.icloud).toContain("account.apple.com");
    expect(PROVIDER_HINTS.custom).toContain("smtp.office365.com:587 STARTTLS");
    expect(PROVIDER_HINTS.zoho).toContain("com, eu or in");
  });

  it("retains DNS categories through guards without retaining raw messages", async () => {
    const raw = Object.assign(new Error("getaddrinfo secret.host"), { code: "EAI_AGAIN" });
    const resolve = async () => { throw raw; };
    const error = await checkCustomHostFailure({ host: "mail.example.com", port: 993, kind: "IMAP", allowInsecureLocalhost: false }, resolve);
    expect(error?.category).toBe("host_not_found");
    await expect(resolveHostTarget({ host: "mail.example.com", protocol: "IMAP", allowInsecureLocalhost: false }, resolve))
      .rejects.toMatchObject({ category: "host_not_found" });
    expect(error?.message).not.toContain("secret.host");
  });
});
