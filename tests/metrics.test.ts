import { afterEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { migrate, openDatabase } from "../src/db/index.js";
import { aggregateMetrics, createMetricRecorder, durationBucket, pruneMetrics, recordMetric } from "../src/services/metrics.js";
import { runAdmin } from "../src/cli/admin.js";
import { account } from "./fixtures.js";

let db: Database;
afterEach(() => db?.close());
function setup() { db = openDatabase(":memory:"); migrate(db); return db; }

describe("private daily metrics", () => {
  it("upserts only closed vocabularies and rolls over on the UTC day", () => {
    setup();
    let now = Date.parse("2026-11-01T23:59:59Z");
    const metrics = createMetricRecorder(db, () => now);
    const metric = { kind: "mailbox_test" as const, name: "gmail", outcome: "imap:auth_failed" };
    metrics.record(metric); metrics.record(metric);
    now += 2_000; metrics.record(metric);
    metrics.record({ kind: "tool_call", name: "read_message", outcome: "ok", bucket: "<1s" });
    metrics.record({ ...metric, name: "private@example.com" });
    metrics.record({ ...metric, outcome: "imap:private.host" });
    metrics.record({ ...metric, bucket: "secret" });
    const rows = db.prepare("SELECT * FROM metric_counts ORDER BY day, kind").all();
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({ day: "2026-11-01", count: 2 });
    expect(JSON.stringify(rows)).not.toContain("private");
    expect(aggregateMetrics(db, 14, "mailbox_test", now)).toEqual([{ kind: "mailbox_test", name: "gmail", outcome: "imap:auth_failed", bucket: "", count: 3 }]);
  });

  it("counts get_attachment outcomes without file names", () => {
    setup();
    const metrics = createMetricRecorder(db, () => Date.parse("2026-11-11T12:00:00Z"));
    metrics.record({ kind: "tool_call", name: "get_attachment", outcome: "ok", bucket: "<1s" });
    metrics.record({ kind: "tool_call", name: "get_attachment", outcome: "too_large", bucket: "1-5s" });
    metrics.record({ kind: "tool_call", name: "get_attachment", outcome: "parse_error", bucket: "<1s" });
    metrics.record({ kind: "tool_call", name: "invoice-NW-2026-1042.pdf", outcome: "ok", bucket: "<1s" });
    metrics.record({ kind: "tool_call", name: "get_attachment", outcome: "invoice.pdf", bucket: "<1s" });
    const rows = aggregateMetrics(db, 14, "tool_call", Date.parse("2026-11-11T12:00:00Z"));
    expect(rows.map((row) => row.outcome)).toEqual(["ok", "parse_error", "too_large"]);
    expect(JSON.stringify(rows)).not.toContain("pdf");
  });

  it("prunes after 400 UTC days and ignores recorder failures", () => {
    setup();
    const now = Date.parse("2026-11-02T12:00:00Z");
    for (const age of [399, 400]) createMetricRecorder(db, () => now - age * 86_400_000).record({ kind: "auth", name: "login", outcome: "ok" });
    pruneMetrics(db, now);
    expect(db.prepare("SELECT * FROM metric_counts").all()).toHaveLength(1);
    expect(() => recordMetric({ record() { throw new Error("disk full"); } }, { kind: "auth", name: "login", outcome: "ok" })).not.toThrow();
    const recorder = createMetricRecorder(db);
    db.exec("DROP TABLE metric_counts");
    expect(() => recorder.record({ kind: "auth", name: "signup", outcome: "failed" })).not.toThrow();
    expect(() => pruneMetrics(db)).not.toThrow();
  });

  it("uses the specified duration buckets", () => {
    expect([0, 999, 1_000, 4_999, 5_000, 14_999, 15_000, 30_000, 30_001].map(durationBucket))
      .toEqual(["<1s", "<1s", "1-5s", "1-5s", "5-15s", "5-15s", "15-30s", "15-30s", ">30s"]);
  });

  it("prints sorted CLI aggregates, defaults to 14 days, and validates filters", async () => {
    setup();
    createMetricRecorder(db).record({ kind: "auth", name: "login", outcome: "ok" });
    createMetricRecorder(db, () => Date.now() - 15 * 86_400_000).record({ kind: "auth", name: "signup", outcome: "failed" });
    const lines: string[] = [];
    const deps = { db, masterKey: Buffer.alloc(32), imap: {} as never };
    const io = { readSecret: async () => account.password, env: {}, out: (line: string) => lines.push(line) };
    await runAdmin(["metrics", "--json"], deps, io);
    expect(JSON.parse(lines.pop()!)).toEqual([{ kind: "auth", name: "login", outcome: "ok", bucket: "", count: 1 }]);
    await runAdmin(["metrics", "--days", "30", "--kind", "auth"], deps, io);
    expect(lines.join("\n")).toContain("total=2");
    for (const args of [["--days", "0"], ["--days", "401"], ["--days"], ["--kind", "personal"], ["--json", "false"]]) {
      await expect(runAdmin(["metrics", ...args], deps, io)).rejects.toThrow();
    }
  });
});
