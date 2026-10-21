import type Database from "better-sqlite3";
import { migrations } from "./migrations/index.js";

export function migrate(db: Database): void {
  let previous = 0;
  for (const migration of migrations) {
    if (!Number.isInteger(migration.version) || migration.version <= previous) {
      throw new Error("Migration versions must be increasing positive integers");
    }
    previous = migration.version;
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    )
  `);

  const rows = db.prepare("SELECT version FROM schema_migrations").all() as { version: number }[];
  const applied = new Set(rows.map((row) => row.version));
  const newest = migrations[migrations.length - 1]?.version ?? 0;
  for (const version of applied) {
    if (version > newest) {
      throw new Error(`Database schema version ${version} is newer than this build (${newest})`);
    }
  }

  for (const migration of migrations) {
    if (applied.has(migration.version)) continue;
    const apply = db.transaction(() => {
      db.exec(migration.sql);
      db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(
        migration.version,
        new Date().toISOString(),
      );
    });
    apply();
  }
}
