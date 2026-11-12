import type { Migration } from "../migration.js";
import { sql as initSql, version as initVersion } from "./001_init.js";
import { sql as oauthSql, version as oauthVersion } from "./002_oauth.js";
import { sql as sendingSql, version as sendingVersion } from "./003_sending.js";

import { sql as metricsSql, version as metricsVersion } from "./004_metrics.js";
import { sql as resetsSql, version as resetsVersion } from "./005_password_resets.js";
import { sql as requestedScopeSql, version as requestedScopeVersion } from "./006_requested_scope.js";

export const migrations: readonly Migration[] = [
  { version: initVersion, sql: initSql },
  { version: oauthVersion, sql: oauthSql },
  { version: sendingVersion, sql: sendingSql },
  { version: metricsVersion, sql: metricsSql },
  { version: resetsVersion, sql: resetsSql },
  { version: requestedScopeVersion, sql: requestedScopeSql },
];
