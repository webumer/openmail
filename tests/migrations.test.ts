import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { migrate, openDatabase, resolveDatabasePath } from "../src/db/index.js";
import { migrations } from "../src/db/migrations/index.js";

const open: Database[] = [];

afterEach(() => {
  for (const db of open) db.close();
  open.length = 0;
});

describe("migrations", () => {
  it("applies numbered migrations once and is safe to run again", () => {
    const db = track(openDatabase(":memory:"));
    migrate(db);
    const first = db.prepare("SELECT version, applied_at FROM schema_migrations").all() as {
      version: number;
      applied_at: string;
    }[];
    expect(first).toEqual([
      { version: 1, applied_at: expect.any(String) },
      { version: 2, applied_at: expect.any(String) },
      { version: 3, applied_at: expect.any(String) },
    ]);

    migrate(db);
    const second = db.prepare("SELECT version, applied_at FROM schema_migrations").all();
    expect(second).toEqual(first);

    expect(tableNames(db)).toEqual([
      "api_keys",
      "mail_accounts",
      "oauth_clients",
      "oauth_codes",
      "oauth_grants",
      "oauth_tokens",
      "schema_migrations",
      "send_log",
      "sessions",
      "users",
    ]);
    expect(columnNames(db, "users")).toEqual(["id", "email", "password_hash", "wrapped_data_key", "created_at"]);
    expect(columnNames(db, "sessions")).toEqual(["id", "user_id", "csrf_secret", "created_at", "expires_at"]);
    expect(columnNames(db, "api_keys")).toEqual([
      "id",
      "user_id",
      "name",
      "prefix",
      "key_hash",
      "created_at",
      "last_used_at",
      "revoked_at",
      "can_send",
    ]);
    expect(columnNames(db, "oauth_tokens")).toEqual([
      "token_hash",
      "grant_id",
      "kind",
      "created_at",
      "expires_at",
      "rotated_at",
      "revoked_at",
      "scope",
    ]);
    expect(columnNames(db, "mail_accounts")).toEqual([
      "id",
      "user_id",
      "name",
      "email",
      "username",
      "preset",
      "imap_host",
      "imap_port",
      "imap_secure",
      "smtp_host",
      "smtp_port",
      "smtp_secure",
      "smtp_starttls",
      "password_ciphertext",
      "password_iv",
      "password_tag",
      "created_at",
      "send_enabled",
      "smtp_username",
      "smtp_password_ciphertext",
      "smtp_password_iv",
      "smtp_password_tag",
    ]);
  });

  it("upgrades an older database and leaves existing rows read-only", () => {
    const db = track(openDatabase(":memory:"));
    db.exec(`CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)`);
    for (const migration of migrations) {
      if (migration.version >= 3) break;
      db.exec(migration.sql);
      db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(migration.version, "2026-01-01T00:00:00.000Z");
    }
    db.prepare(
      `INSERT INTO users (id, email, password_hash, wrapped_data_key, created_at) VALUES (?, ?, ?, ?, ?)`,
    ).run("user-1", "ada@example.com", "hash", Buffer.from("key"), "2026-01-01T00:00:00.000Z");
    db.prepare(
      `INSERT INTO mail_accounts (
         id, user_id, name, email, username, preset,
         imap_host, imap_port, imap_secure, smtp_host, smtp_port, smtp_secure, smtp_starttls,
         password_ciphertext, password_iv, password_tag, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "acct-1", "user-1", "Work", "ada@example.com", "ada@example.com", "migadu",
      "imap.migadu.com", 993, 1, "smtp.migadu.com", 465, 1, 0,
      Buffer.from("cipher"), Buffer.alloc(12), Buffer.alloc(16), "2026-01-01T00:00:00.000Z",
    );
    db.prepare(
      `INSERT INTO api_keys (id, user_id, name, prefix, key_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run("key-1", "user-1", "Laptop", "om_prefix", "ab".repeat(32), "2026-01-01T00:00:00.000Z");
    migrate(db);
    const account = db.prepare("SELECT send_enabled, smtp_username FROM mail_accounts WHERE id = ?").get("acct-1") as {
      send_enabled: number;
      smtp_username: string | null;
    };
    const key = db.prepare("SELECT can_send FROM api_keys WHERE id = ?").get("key-1") as { can_send: number };
    expect(account).toEqual({ send_enabled: 0, smtp_username: null });
    expect(key.can_send).toBe(0);
    const scope = (db.prepare("PRAGMA table_info(oauth_tokens)").all() as { name: string; notnull: number }[]).find(
      (column) => column.name === "scope",
    );
    expect(scope?.name).toBe("scope");
    expect(scope?.notnull).toBe(0);
  });

  it("creates the parent directory for a file database and enforces foreign keys", () => {
    const dir = mkdtempSync(join(tmpdir(), "openmail-db-"));
    const db = track(openDatabase(join(dir, "nested", "openmail.db")));
    migrate(db);
    migrate(db);
    expect(() => {
      db.prepare(
        `INSERT INTO api_keys (id, user_id, name, prefix, key_hash, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run("key-1", "missing-user", "laptop", "om_test_prefx", "ab".repeat(32), "2026-01-01T00:00:00.000Z");
    }).toThrow(/FOREIGN KEY/);
  });

  it("refuses a database written by a newer build", () => {
    const db = track(openDatabase(":memory:"));
    migrate(db);
    db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (99, ?)").run("2026-01-01T00:00:00.000Z");
    expect(() => migrate(db)).toThrow(/newer than this build/);
  });

  it("defaults the database path and honors OPENMAIL_DB_PATH", () => {
    expect(resolveDatabasePath({})).toBe("./data/openmail.db");
    expect(resolveDatabasePath({ OPENMAIL_DB_PATH: "  " })).toBe("./data/openmail.db");
    expect(resolveDatabasePath({ OPENMAIL_DB_PATH: "/tmp/openmail.db" })).toBe("/tmp/openmail.db");
  });
});

function track(db: Database): Database {
  open.push(db);
  return db;
}

function tableNames(db: Database): string[] {
  const rows = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all() as { name: string }[];
  return rows.map((row) => row.name);
}

function columnNames(db: Database, table: string): string[] {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  return rows.map((row) => row.name);
}
