import type { Migration } from "../migration.js";
import { sql as initSql, version as initVersion } from "./001_init.js";
import { sql as oauthSql, version as oauthVersion } from "./002_oauth.js";

export const migrations: readonly Migration[] = [
  { version: initVersion, sql: initSql },
  { version: oauthVersion, sql: oauthSql },
];
