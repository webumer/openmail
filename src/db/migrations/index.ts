import type { Migration } from "../migration.js";
import { sql as initSql, version as initVersion } from "./001_init.js";

export const migrations: readonly Migration[] = [{ version: initVersion, sql: initSql }];
