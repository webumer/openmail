import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config/index.js";
import { MailError } from "../src/errors.js";
import { ConfigCredentialStore } from "../src/store/config-store.js";
import { fileURLToPath } from "node:url";
import { SECRET } from "./fixtures.js";

const examplePath = fileURLToPath(new URL("../config.example.toml", import.meta.url));

describe("ConfigCredentialStore", () => {
  it("lists public account fields and resolves the secret from the environment", async () => {
    const store = new ConfigCredentialStore(loadConfig(examplePath), {
      OPENMAIL_ACCT_WORK_PASSWORD: SECRET,
    });
    const listed = await store.listAccounts("user-1");
    expect(listed).toEqual([
      {
        id: "work",
        label: "Work",
        email: "you@example.com",
        preset: "migadu",
        imapHost: "imap.migadu.com",
      },
    ]);
    expect(JSON.stringify(listed)).not.toContain(SECRET);

    const account = await store.getAccount("user-1", "work");
    expect(account?.password).toBe(SECRET);
    expect(account?.username).toBe("you@example.com");
    expect(account?.imap).toEqual({ host: "imap.migadu.com", port: 993, secure: true });
    expect(await store.getAccount("user-1", "missing")).toBeNull();
  });

  it("fails closed when the password env var is unset", async () => {
    const store = new ConfigCredentialStore(loadConfig(examplePath), {});
    await expect(store.getAccount("user-1", "work")).rejects.toThrow(MailError);
    await expect(store.getAccount("user-1", "work")).rejects.toThrow(/OPENMAIL_ACCT_WORK_PASSWORD/);
  });

  it("resolves a Zoho regional host", async () => {
    const config = loadConfig(examplePath);
    config.accounts[0] = {
      id: "eu",
      label: "EU",
      email: "person@example.com",
      preset: "zoho",
      passwordEnv: "OPENMAIL_ACCT_EU_PASSWORD",
      zohoRegion: "eu",
    };
    const store = new ConfigCredentialStore(config, { OPENMAIL_ACCT_EU_PASSWORD: SECRET });
    const listed = await store.listAccounts("user-1");
    expect(listed[0]?.imapHost).toBe("imap.zoho.eu");
    const account = await store.getAccount("user-1", "eu");
    expect(account?.smtp.host).toBe("smtp.zoho.eu");
  });
});
