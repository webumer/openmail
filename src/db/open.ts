import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";

export function resolveDatabasePath(env: { OPENMAIL_DB_PATH?: string } = process.env): string {
  const configured = env.OPENMAIL_DB_PATH?.trim();
  if (configured) return configured;
  return "./data/openmail.db";
}

export function openDatabase(filename: string): Database {
  if (filename !== ":memory:" && !filename.startsWith("file:")) {
    mkdirSync(dirname(filename), { recursive: true });
  }
  const db = new Database(filename);
  db.pragma("foreign_keys = ON");
  if (filename !== ":memory:") db.pragma("journal_mode = WAL");
  return db;
}
