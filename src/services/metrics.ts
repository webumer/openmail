import type Database from "better-sqlite3";
import { PROVIDER_PRESETS } from "../mail/presets.js";
import { FAILURE_CATEGORIES } from "../errors.js";

export const METRIC_KINDS = ["mailbox_test", "mailbox_save", "tool_call", "auth", "mcp_rate_limited", "unknown_tool"] as const;
export type MetricKind = (typeof METRIC_KINDS)[number];
export const TOOL_NAMES = ["list_accounts", "list_folders", "search_messages", "read_message", "read_thread", "send_message"] as const;
const TOOL_OUTCOMES = ["ok", "setup_required", "imap_error", "smtp_error", "timeout", "not_found", "rate_limited",
  "invalid_argument", "invalid_input", "invalid_cursor", "config_error", "send_not_permitted", "sending_disabled",
  "insecure_transport", "blocked_host", "parse_error", "missing_secret", "limit_reached", "conflict", "internal_error", "unknown_error"];
const BUCKETS = ["<1s", "1-5s", "5-15s", "15-30s", ">30s"];

export interface Metric {
  kind: MetricKind;
  name: string;
  outcome: string;
  bucket?: string;
}

export interface MetricRecorder {
  record(metric: Metric): void;
}
export const noopMetrics: MetricRecorder = { record() {} };

/** Even an injected recorder must never affect the request path. */
export function recordMetric(recorder: MetricRecorder | undefined, metric: Metric): void {
  try {
    recorder?.record(metric);
  } catch {
    // Metrics are best effort.
  }
}

export function durationBucket(ms: number): string {
  if (ms < 1_000) return "<1s";
  if (ms < 5_000) return "1-5s";
  if (ms < 15_000) return "5-15s";
  if (ms <= 30_000) return "15-30s";
  return ">30s";
}

export function toolOutcome(code: string): string {
  return TOOL_OUTCOMES.includes(code) ? code : "unknown_error";
}

/** Closed vocabularies prevent accidental personal data from becoming a metric dimension. */
function valid(metric: Metric): boolean {
  const { kind, name, outcome, bucket = "" } = metric;
  if (kind === "tool_call") return (TOOL_NAMES as readonly string[]).includes(name) && TOOL_OUTCOMES.includes(outcome) && BUCKETS.includes(bucket);
  if (bucket !== "") return false;
  if (kind === "auth") return ["login", "signup", "reset_request", "reset_complete"].includes(name) && ["ok", "failed", "rate_limited"].includes(outcome);
  if (kind === "mcp_rate_limited") return name === "mcp" && outcome === "429";
  if (kind === "unknown_tool") return name === "mcp" && outcome === "not_found";
  if (kind !== "mailbox_test" && kind !== "mailbox_save") return false;
  return (PROVIDER_PRESETS as readonly string[]).includes(name) && (outcome === "ok" ||
    ["imap", "smtp"].some((part) => FAILURE_CATEGORIES.some((category) => outcome === `${part}:${category}`)));
}

export function createMetricRecorder(db: Database, now: () => number = Date.now): MetricRecorder {
  return {
    record(metric) {
      try {
        if (!valid(metric)) return;
        db.prepare(`INSERT INTO metric_counts (day, kind, name, outcome, bucket, count) VALUES (?, ?, ?, ?, ?, 1)
          ON CONFLICT(day, kind, name, outcome, bucket) DO UPDATE SET count = count + 1`)
          .run(new Date(now()).toISOString().slice(0, 10), metric.kind, metric.name, metric.outcome, metric.bucket ?? "");
      } catch { /* Never fail a request for a counter. */ }
    },
  };
}

/** Keep 400 UTC calendar days, including today. */
export function pruneMetrics(db: Database, now = Date.now()): void {
  try {
    db.prepare("DELETE FROM metric_counts WHERE day < ?").run(new Date(now - 399 * 86_400_000).toISOString().slice(0, 10));
  } catch {
    // Pruning must not stop startup.
  }
}

export interface MetricCount {
  kind: string;
  name: string;
  outcome: string;
  bucket: string;
  count: number;
}
export function aggregateMetrics(db: Database, days = 14, kind?: MetricKind, now = Date.now()): MetricCount[] {
  const since = new Date(now - (days - 1) * 86_400_000).toISOString().slice(0, 10);
  const until = new Date(now).toISOString().slice(0, 10);
  return db.prepare(`SELECT kind, name, outcome, bucket, SUM(count) AS count FROM metric_counts
    WHERE day >= ? AND day <= ? ${kind ? "AND kind = ?" : ""}
    GROUP BY kind, name, outcome, bucket ORDER BY kind, name, outcome, bucket`)
    .all(since, until, ...(kind ? [kind] : [])) as MetricCount[];
}
