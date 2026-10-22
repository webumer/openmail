import type { Migration } from "../migration.js";
import { sql as initSql, version as initVersion } from "./001_init.js";
import { sql as oauthSql, version as oauthVersion } from "./002_oauth.js";
import { sql as sendingSql, version as sendingVersion } from "./003_sending.js";

export const migrations: readonly Migration[] = [
  { version: initVersion, sql: initSql },
  { version: oauthVersion, sql: oauthSql },
  { version: sendingVersion, sql: sendingSql },
];
