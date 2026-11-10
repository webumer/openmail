import { ChildProcess, fork, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AttachmentLimits } from "../src/config/runtime.js";
import { MailError } from "../src/errors.js";
import { getAttachment } from "../src/mail/get-attachment.js";
import type { ImapGateway } from "../src/mail/imap-gateway.js";
import { createPdfPool, killPdfChildren, pdfChildEntry, runPdfChild, startPdfChild, type PdfRunner } from "../src/mail/pdf.js";
import type { CredentialStore } from "../src/store/types.js";
import { RecordingSession, account, fetched } from "./fixtures.js";
import { flateBomb, simplePdf, textStream } from "./helpers/pdf.js";

// With `swallowJob.on`, children forked by pdf.ts never get their job and idle until killed.
const swallowJob = vi.hoisted(() => ({ on: false }));
vi.mock("node:child_process", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:child_process")>();
  return {
    ...original,
    fork: (...args: Parameters<typeof original.fork>) => {
      const child = original.fork(...args);
      if (swallowJob.on) {
        child.send = ((_message: unknown, callback?: (err: Error | null) => void) => {
          callback?.(null);
          return true;
        }) as typeof child.send;
      }
      return child;
    },
  };
});

const PDF = new Uint8Array(simplePdf(["hello"]));
const JOB = { maxPages: 5, maxChars: 1_000, timeoutMs: 5_000 };

/**
 * A runner whose calls stay pending until the test settles them. By default the
 * fake process exits when the call settles; with `holdExit` it exits only on `exit()`.
 */
function controlledRunner(holdExit = false) {
  const calls: { timeoutMs: number; signal: AbortSignal; resolve: () => void; exit: () => void }[] = [];
  const run: PdfRunner = (_bytes, job, signal) => {
    let exit!: () => void;
    const exited = new Promise<void>((resolve) => (exit = resolve));
    const result = new Promise<{ pages: number; pagesRead: number; text: string; chars: number }>((resolve, reject) => {
      signal.addEventListener("abort", () => reject(new MailError("cancelled", "cancelled")), { once: true });
      calls.push({ timeoutMs: job.timeoutMs, signal, resolve: () => resolve({ pages: 1, pagesRead: 1, text: "ok", chars: 2 }), exit });
    });
    if (!holdExit) void result.then(exit, exit);
    return { result, exited };
  };
  return { run, calls };
}

/** True while a process with this pid exists (zombies included). */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function exitOf(child: ChildProcess): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
}

async function waitUntil(check: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return check();
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

  it("holds a running slot until the process has exited, not just until the call settles", async () => {
    const { run, calls } = controlledRunner(true);
    const pool = createPdfPool({ maxRunning: 1, run });
    const first = new AbortController();
    const a = pool.admit(1).extract(PDF, JOB, first.signal);
    const b = pool.admit(1).extract(PDF, JOB);
    await tick();
    first.abort();
    await expect(a).rejects.toMatchObject({ code: "cancelled" });
    await tick();
    // The first process was killed but has not exited: the second still waits.
    expect(pool.stats).toMatchObject({ running: 1, waiting: 1 });
    expect(calls).toHaveLength(1);
    calls[0]!.exit();
    await tick();
    expect(calls).toHaveLength(2);
    calls[1]!.resolve();
    await expect(b).resolves.toMatchObject({ text: "ok" });
    expect(pool.stats.running).toBe(1);
    calls[1]!.exit();
    await tick();
    expect(pool.stats.running).toBe(0);
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
    expect(await waitUntil(() => pool.stats.running === 0, 2_000)).toBe(true);
    expect(pool.stats).toEqual({ admitted: 0, admittedBytes: 0, running: 0, waiting: 0 });
  });
});

describe("PDF child process", () => {
  const signal = () => new AbortController().signal;
  afterEach(() => {
    swallowJob.on = false;
    vi.restoreAllMocks();
    killPdfChildren();
  });

  it("frees the slot only after a killed child has exited, and the process is gone by then", async () => {
    const run = startPdfChild(simplePdf(["a"]), { maxPages: 5, maxChars: 100, timeoutMs: 1 }, signal());
    let exited = false;
    void run.exited.then(() => (exited = true));
    await expect(run.result).rejects.toMatchObject({ code: "parse_error" });
    await run.exited;
    expect(exited).toBe(true);
    expect(alive(run.pid!)).toBe(false);
  });

  it("keeps sending SIGKILL when a kill fails, and holds the slot until the child exits", async () => {
    const real = ChildProcess.prototype.kill;
    let attempts = 0;
    vi.spyOn(ChildProcess.prototype, "kill").mockImplementation(function (this: ChildProcess, sig?: NodeJS.Signals | number) {
      attempts += 1;
      return attempts <= 2 ? false : real.call(this, sig);
    });
    swallowJob.on = true;
    const pool = createPdfPool({ maxRunning: 1, run: (bytes, job, s) => startPdfChild(bytes, job, s) });
    const cancel = new AbortController();
    const extraction = pool.admit(1).extract(PDF, JOB, cancel.signal);
    await tick();
    cancel.abort();
    await expect(extraction).rejects.toMatchObject({ code: "cancelled" });
    expect(pool.stats.running).toBe(1);
    const cancelled = Date.now();
    expect(await waitUntil(() => pool.stats.running === 0, 5_000)).toBe(true);
    // Two failed attempts, then the retry a second later succeeds.
    expect(attempts).toBe(3);
    expect(Date.now() - cancelled).toBeGreaterThanOrEqual(1_500);
  });

  it("kills every running child on killPdfChildren", async () => {
    const run = startPdfChild(simplePdf(["a"]), { maxPages: 5, maxChars: 100, timeoutMs: 30_000 }, signal());
    killPdfChildren();
    await expect(run.result).rejects.toMatchObject({ code: "parse_error" });
    await run.exited;
    expect(alive(run.pid!)).toBe(false);
  });

  it("kills itself at its own deadline even when the server never sends a job or kills it", async () => {
    const entry = pdfChildEntry();
    const child = fork(entry.path, ["300"], { execArgv: entry.execArgv, env: {}, stdio: ["ignore", "ignore", "ignore", "ipc"] });
    const started = Date.now();
    expect((await exitOf(child)).signal).toBe("SIGKILL");
    expect(Date.now() - started).toBeGreaterThanOrEqual(250);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("exits when the IPC channel to the server closes", async () => {
    const entry = pdfChildEntry();
    const child = fork(entry.path, ["60000"], { execArgv: entry.execArgv, env: {}, stdio: ["ignore", "ignore", "ignore", "ipc"] });
    await new Promise((resolve) => child.once("spawn", resolve));
    await new Promise((resolve) => setTimeout(resolve, 300));
    child.disconnect();
    expect((await exitOf(child)).code).toBe(1);
  });

  it.each([
    ["SIGTERM", 143],
    ["SIGINT", 130],
  ])("kills running children when the server gets %s, and exits %i", async (name, status) => {
    const fixture = fileURLToPath(new URL("./helpers/pdf-parent.ts", import.meta.url));
    const tsx = fileURLToPath(new URL("../node_modules/tsx/dist/esm/index.mjs", import.meta.url));
    const parent = spawn(process.execPath, ["--import", tsx, fixture, name], { stdio: ["ignore", "pipe", "inherit"] });
    let out = "";
    parent.stdout.on("data", (chunk: Buffer) => (out += chunk.toString()));
    expect((await exitOf(parent)).code).toBe(status);
    const pid = Number(/child (\d+)/.exec(out)?.[1]);
    expect(pid).toBeGreaterThan(0);
    expect(await waitUntil(() => !alive(pid), 2_000)).toBe(true);
  });

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

  // prlimit ships with util-linux (in the Docker image); macOS has no RLIMIT_DATA tool.
  it.runIf(process.platform === "linux" && existsSync("/usr/bin/prlimit"))("stops a decompression bomb at the kernel data limit even with the watchdog off", async () => {
    const bomb = simplePdf(["unused"], { 0: await flateBomb(1024 * 1024 * 1024) });
    const run = startPdfChild(bomb, { maxPages: 1, maxChars: 100, timeoutMs: 30_000 }, signal(), { rssLimitBytes: Number.MAX_SAFE_INTEGER, dataLimitBytes: 256 * 1024 * 1024 });
    // Depending on where allocation fails, V8 aborts or pdf.js reports the error; either way the server gets parse_error.
    await expect(run.result).rejects.toMatchObject({ code: "parse_error" });
  }, 60_000);
});
