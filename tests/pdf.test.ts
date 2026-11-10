import { describe, expect, it } from "vitest";
import type { AttachmentLimits } from "../src/config/runtime.js";
import { MailError } from "../src/errors.js";
import { getAttachment } from "../src/mail/get-attachment.js";
import type { ImapGateway } from "../src/mail/imap-gateway.js";
import { createPdfPool, runPdfChild, type PdfRunner } from "../src/mail/pdf.js";
import type { CredentialStore } from "../src/store/types.js";
import { RecordingSession, account, fetched } from "./fixtures.js";
import { flateBomb, simplePdf, textStream } from "./helpers/pdf.js";

const PDF = new Uint8Array(simplePdf(["hello"]));
const JOB = { maxPages: 5, maxChars: 1_000, timeoutMs: 5_000 };

/** A runner whose calls stay pending until the test settles them. */
function controlledRunner() {
  const calls: { timeoutMs: number; signal: AbortSignal; resolve: () => void }[] = [];
  const run: PdfRunner = (_bytes, job, signal) => new Promise((resolve, reject) => {
    signal.addEventListener("abort", () => reject(new MailError("cancelled", "cancelled")), { once: true });
    calls.push({ timeoutMs: job.timeoutMs, signal, resolve: () => resolve({ pages: 1, pagesRead: 1, text: "ok", chars: 2 }) });
  });
  return { run, calls };
}

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("PDF pool", () => {
  it("bounds admitted PDFs by count and reserved bytes, and frees places on release", () => {
    const pool = createPdfPool({ maxRunning: 1, maxAdmitted: 2, maxAdmittedBytes: 100 });
    const big = pool.admit(500); // one PDF is always admitted when none are
    expect(() => pool.admit(1)).toThrow(expect.objectContaining({ code: "rate_limited" }));
    big.release();
    big.release(); // idempotent
    const a = pool.admit(60);
    expect(() => pool.admit(50)).toThrow(expect.objectContaining({ code: "rate_limited" }));
    const b = pool.admit(40);
    expect(() => pool.admit(0)).toThrow(expect.objectContaining({ code: "rate_limited" }));
    b.resize(10);
    expect(pool.stats).toMatchObject({ admitted: 2, admittedBytes: 70 });
    a.release();
    b.release();
    expect(pool.stats).toEqual({ admitted: 0, admittedBytes: 0, running: 0, waiting: 0 });
  });

  it("queues past the running limit, counts queue time in the deadline, and gives up when the deadline passes", async () => {
    const { run, calls } = controlledRunner();
    const pool = createPdfPool({ maxRunning: 1, maxAdmitted: 4, run });
    const first = pool.admit(1);
    const second = pool.admit(1);
    const running = first.extract(PDF, { ...JOB, timeoutMs: 5_000 });
    const queued = second.extract(PDF, { ...JOB, timeoutMs: 60 });
    await tick();
    expect(pool.stats).toMatchObject({ running: 1, waiting: 1 });
    await expect(queued).rejects.toMatchObject({ code: "rate_limited" });
    expect(pool.stats).toMatchObject({ running: 1, waiting: 0 });
    calls[0]!.resolve();
    await expect(running).resolves.toMatchObject({ text: "ok" });
    expect(calls).toHaveLength(1);
    expect(pool.stats).toMatchObject({ running: 0, waiting: 0 });

    // A job that waited gets only what is left of its budget.
    const third = pool.admit(1);
    const fourth = pool.admit(1);
    const blocking = third.extract(PDF, JOB);
    const waited = fourth.extract(PDF, { ...JOB, timeoutMs: 1_000 });
    await new Promise((resolve) => setTimeout(resolve, 200));
    calls[1]!.resolve();
    await blocking;
    await tick();
    expect(calls[2]!.timeoutMs).toBeLessThanOrEqual(810);
    calls[2]!.resolve();
    await waited;
    for (const ticket of [first, second, third, fourth]) ticket.release();
  });

  it("never runs more than maxRunning when several waiters are woken", async () => {
    const { run, calls } = controlledRunner();
    const pool = createPdfPool({ maxRunning: 1, run });
    const jobs = [1, 2, 3].map(() => pool.admit(1).extract(PDF, JOB));
    await tick();
    expect(pool.stats).toMatchObject({ running: 1, waiting: 2 });
    calls[0]!.resolve();
    await jobs[0];
    await tick();
    expect(calls).toHaveLength(2);
    expect(pool.stats).toMatchObject({ running: 1, waiting: 1 });
    calls[1]!.resolve();
    await jobs[1];
    await tick();
    calls[2]!.resolve();
    await jobs[2];
    expect(pool.stats).toMatchObject({ running: 0, waiting: 0 });
  });

  it("removes a cancelled job from the queue and aborts a running one", async () => {
    const { run, calls } = controlledRunner();
    const pool = createPdfPool({ maxRunning: 1, run });
    const running = new AbortController();
    const queued = new AbortController();
    const a = pool.admit(1).extract(PDF, JOB, running.signal);
    const b = pool.admit(1).extract(PDF, JOB, queued.signal);
    await tick();
    queued.abort();
    await expect(b).rejects.toMatchObject({ code: "cancelled" });
    expect(pool.stats.waiting).toBe(0);
    running.abort();
    await expect(a).rejects.toMatchObject({ code: "cancelled" });
    expect(calls[0]!.signal.aborted).toBe(true);
    expect(pool.stats.running).toBe(0);
    const already = new AbortController();
    already.abort();
    await expect(pool.admit(1).extract(PDF, JOB, already.signal)).rejects.toMatchObject({ code: "cancelled" });
    expect(calls).toHaveLength(1);
  });

  it("get_attachment takes its place before downloading and reports rate_limited without fetching when the pool is full", async () => {
    const pool = createPdfPool({ maxAdmitted: 1 });
    const held = pool.admit(1);
    const session = new RecordingSession();
    session.messages.set(7, fetched({ uid: 7, bodyStructure: {
      type: "multipart/mixed",
      childNodes: [{ type: "text/plain", part: "1" }, { type: "application/pdf", part: "2", disposition: "attachment", dispositionParameters: { filename: "a.pdf" }, encoding: "7bit", size: PDF.length }],
    } }));
    session.parts.set("7:2", Buffer.from(PDF));
    const imap: ImapGateway = {
      async withClient(_a, fn) { return fn(session); },
      async withMailbox(_a, _f, fn) { return fn(session); },
      async appendMessage() { throw new Error("must not append"); },
    };
    const store: CredentialStore = { async listAccounts() { return []; }, async getAccount() { return account; } };
    const limits: AttachmentLimits = { maxBytes: 1024 * 1024, base64MaxBytes: 1024 * 1024, pdfMaxPages: 5, pdfTimeoutMs: 10_000 };
    const deps = { store, imap, attachmentLimits: limits, pdfPool: pool };
    const busy = await getAttachment(deps, "user-1", "work", "INBOX", 7, { index: 0 });
    expect(busy).toMatchObject({ ok: false, error: { code: "rate_limited" } });
    expect(session.partFetches).toEqual([]);
    held.release();
    const done = await getAttachment(deps, "user-1", "work", "INBOX", 7, { index: 0 });
    expect(done).toMatchObject({ ok: true, data: { kind: "pdf", text: "hello" } });
    expect(pool.stats).toEqual({ admitted: 0, admittedBytes: 0, running: 0, waiting: 0 });
  });
});

describe("PDF child process", () => {
  const signal = () => new AbortController().signal;

  it("sends back at most maxChars even when one page holds far more, and counts the rest", async () => {
    const lines = Array.from({ length: 400 }, (_, i) => `row ${i} ${"y".repeat(40)}`);
    const result = await runPdfChild(simplePdf(["unused"], { 0: textStream(lines, 6_000) }, 6_000), { maxPages: 5, maxChars: 100, timeoutMs: 10_000 }, signal());
    expect(result.text.length).toBe(100);
    expect(result.chars).toBeGreaterThan(15_000);
  });

  it("kills the process at the deadline", async () => {
    const started = Date.now();
    await expect(runPdfChild(simplePdf(["a"]), { maxPages: 5, maxChars: 100, timeoutMs: 1 }, signal()))
      .rejects.toMatchObject({ code: "parse_error", message: expect.stringContaining("too long") });
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("kills a decompression bomb on resident memory, outside the server process", async () => {
    // ~600 KB of deflate that pdf.js expands into a buffer of hundreds of MB, outside the V8 heap.
    const bomb = simplePdf(["unused"], { 0: await flateBomb(768 * 1024 * 1024) });
    expect(bomb.length).toBeLessThan(2 * 1024 * 1024);
    const before = process.memoryUsage().rss;
    await expect(runPdfChild(bomb, { maxPages: 1, maxChars: 100, timeoutMs: 30_000 }, signal(), { rssLimitBytes: 200 * 1024 * 1024 }))
      .rejects.toMatchObject({ code: "parse_error", message: expect.stringContaining("too much memory") });
    expect(process.memoryUsage().rss - before).toBeLessThan(100 * 1024 * 1024);
  }, 40_000);
});
