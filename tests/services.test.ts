import { afterEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { generateTestMasterKey, loadMasterKey } from "../src/crypto/index.js";
import { migrate, openDatabase } from "../src/db/index.js";
import { MailError } from "../src/errors.js";
import { mailAccounts, users } from "../src/services/index.js";
import { SqliteCredentialStore } from "../src/store/index.js";

const USER_PASSWORD = "user-password-1";
const MAILBOX_PASSWORD = "mailbox-secret-value";
const open: Database[] = [];

afterEach(() => {
  for (const db of open) db.close();
  open.length = 0;
});

describe("users", () => {
  it("creates a user, verifies the password, and hides the password from errors", async () => {
    const db = memory();
    const master = loadMasterKey(generateTestMasterKey());
    const short = "too-short";
    await expect(users.create(db, master, { email: "ada@example.com", password: short })).rejects.toThrow(
      /10 to 200 characters/,
    );
    await expect(users.create(db, master, { email: "ada@example.com", password: short })).rejects.toThrow(MailError);
    try {
      await users.create(db, master, { email: "ada@example.com", password: short });
    } catch (err) {
      expect((err as Error).message).not.toContain(short);
    }

    const created = await users.create(db, master, { email: " Ada@Example.com ", password: USER_PASSWORD });
    expect(created.email).toBe("ada@example.com");
    const row = db.prepare("SELECT password_hash, wrapped_data_key FROM users WHERE id = ?").get(created.id) as {
      password_hash: string;
      wrapped_data_key: Buffer;
    };
    expect(row.password_hash).not.toContain(USER_PASSWORD);
    expect(row.wrapped_data_key.toString("utf8")).not.toContain(USER_PASSWORD);
    expect(row.wrapped_data_key).toHaveLength(60);

    await expect(users.create(db, master, { email: "ada@example.com", password: USER_PASSWORD })).rejects.toThrow(
      /already exists/,
    );
    expect(await users.verifyPassword(db, { email: "ADA@example.com", password: USER_PASSWORD })).toEqual(created);
    expect(await users.verifyPassword(db, { email: "ada@example.com", password: "wrong-password" })).toBeNull();
    expect(await users.verifyPassword(db, { email: "missing@example.com", password: USER_PASSWORD })).toBeNull();
    expect(await users.verifyPassword(db, { email: "not-an-email", password: USER_PASSWORD })).toBeNull();
  });
});

describe("mail accounts", () => {
  it("stores a sealed password and lists public fields only for that user", async () => {
    const db = memory();
    const master = loadMasterKey(generateTestMasterKey());
    const ada = await users.create(db, master, { email: "ada@example.com", password: USER_PASSWORD });
    const bob = await users.create(db, master, { email: "bob@example.com", password: "bob-password-1" });
    const added = mailAccounts.add(db, master, {
      userId: ada.id,
      name: "Work",
      email: "ada@work.example",
      preset: "migadu",
      password: MAILBOX_PASSWORD,
    });
    expect(added).toMatchObject({
      name: "Work",
      email: "ada@work.example",
      preset: "migadu",
      imapHost: "imap.migadu.com",
    });
    expect(JSON.stringify(mailAccounts.list(db, ada.id))).not.toContain(MAILBOX_PASSWORD);
    expect(mailAccounts.list(db, bob.id)).toEqual([]);

    const sameName = mailAccounts.add(db, master, {
      userId: bob.id,
      name: "Work",
      email: "bob@work.example",
      preset: "fastmail",
      password: "bob-mailbox-secret",
    });
    expect(sameName.name).toBe("Work");
    expect(() =>
      mailAccounts.add(db, master, {
        userId: ada.id,
        name: "Work",
        email: "ada-other@work.example",
        preset: "icloud",
        password: MAILBOX_PASSWORD,
      }),
    ).toThrow(/already exists/);

    const store = new SqliteCredentialStore(db, master, { allowInsecureLocalhost: false });
    expect(await store.listAccounts(ada.id)).toEqual([
      {
        id: added.id,
        label: "Work",
        email: "ada@work.example",
        preset: "migadu",
        imapHost: "imap.migadu.com",
      },
    ]);
    expect(await store.getAccount(bob.id, added.id)).toBeNull();
    const creds = await store.getAccount(ada.id, added.id);
    expect(creds?.password).toBe(MAILBOX_PASSWORD);
    expect(creds?.username).toBe("ada@work.example");
    expect(creds?.imap).toEqual({ host: "imap.migadu.com", port: 993, secure: true });
    expect(creds?.smtp).toEqual({ host: "smtp.migadu.com", port: 465, secure: true, starttls: false });
    expect(creds?.allowInsecureLocalhost).toBe(false);
    expect(JSON.stringify(await store.listAccounts(ada.id))).not.toContain(MAILBOX_PASSWORD);

    const cloud = mailAccounts.add(db, master, {
      userId: ada.id,
      name: "Phone",
      email: "ada@icloud.example",
      preset: "icloud",
      password: "icloud-app-password",
    });
    expect((await store.getAccount(ada.id, cloud.id))?.smtp).toEqual({
      host: "smtp.mail.me.com",
      port: 587,
      secure: false,
      starttls: true,
    });

    const local = mailAccounts.add(db, master, {
      userId: ada.id,
      name: "Local",
      email: "ada@local.example",
      username: "ada",
      preset: "custom",
      password: "local-mailbox-password",
      imapHost: "127.0.0.1",
      imapPort: 13143,
      imapSecure: false,
      smtpHost: "127.0.0.1",
      smtpPort: 13025,
      smtpSecure: false,
    });
    const insecure = new SqliteCredentialStore(db, master, { allowInsecureLocalhost: true });
    const localCreds = await insecure.getAccount(ada.id, local.id);
    expect(localCreds?.allowInsecureLocalhost).toBe(true);
    expect(localCreds?.imap).toEqual({ host: "127.0.0.1", port: 13143, secure: false });
    expect(localCreds?.username).toBe("ada");

    expect(mailAccounts.remove(db, bob.id, added.id)).toBe(false);
    expect(await store.getAccount(ada.id, added.id)).not.toBeNull();
    expect(mailAccounts.remove(db, ada.id, added.id)).toBe(true);
    expect(await store.getAccount(ada.id, added.id)).toBeNull();
    expect(mailAccounts.list(db, ada.id).map((account) => account.id)).not.toContain(added.id);

    const ciphertext = db
      .prepare("SELECT password_ciphertext FROM mail_accounts WHERE id = ?")
      .get(cloud.id) as { password_ciphertext: Buffer };
    const flipped = Buffer.from(ciphertext.password_ciphertext);
    const first = flipped[0];
    if (first === undefined) throw new Error("missing ciphertext");
    flipped[0] = first ^ 0xff;
    db.prepare("UPDATE mail_accounts SET password_ciphertext = ? WHERE id = ?").run(flipped, cloud.id);
    await expect(store.getAccount(ada.id, cloud.id)).rejects.toThrow("Decryption failed");
  });
});

function memory(): Database {
  const db = openDatabase(":memory:");
  open.push(db);
  migrate(db);
  return db;
}
