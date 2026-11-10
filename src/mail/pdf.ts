import { execFile, fork, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { MailError } from "../errors.js";

export interface PdfText {
  /** Pages in the document. */
  pages: number;
  /** Pages whose text was read (at most the page limit). */
  pagesRead: number;
  /** At most `maxChars` characters. */
  text: string;
  /** Length of all text on the pages read, including what was not kept. */
  chars: number;
}

export interface PdfOptions {
  maxPages: number;
  /** Budget from the moment the PDF is ready: waiting for a free slot plus extraction. */
  timeoutMs: number;
  /** Characters to keep; text on later pages is counted but not returned. */
  maxChars: number;
}

/** Runs one extraction. The default starts a child process; tests inject fakes. */
export type PdfRunner = (bytes: Uint8Array, job: { maxPages: number; maxChars: number; timeoutMs: number }, signal: AbortSignal) => Promise<PdfText>;

export interface PdfPoolOptions {
  /** Extractions running at once. */
  maxRunning?: number;
  /** PDFs admitted at once: downloading, waiting or running. More are refused with rate_limited. */
  maxAdmitted?: number;
  /** Bytes reserved by admitted PDFs. One PDF is always admitted when none are. */
  maxAdmittedBytes?: number;
  run?: PdfRunner;
}

/**
 * A place in the extraction pool, taken before the PDF is downloaded so that
 * pending PDFs (and the bytes they hold) are bounded. Release it when done.
 */
export interface PdfTicket {
  /** Update the reservation once the real size is known. */
  resize(bytes: number): void;
  extract(bytes: Uint8Array, options: PdfOptions, signal?: AbortSignal): Promise<PdfText>;
  release(): void;
}

export interface PdfPool {
  /** Throws MailError("rate_limited") when the pool is full. */
  admit(reservedBytes: number): PdfTicket;
  readonly stats: { admitted: number; admittedBytes: number; running: number; waiting: number };
}

/** Old-generation heap of the parser process. */
const CHILD_HEAP_MB = 256;
/**
 * Resident memory of the parser process, polled by the parent. Array buffers
 * (decoded streams) live outside the V8 heap, so the heap limit alone does not
 * bound them; this does.
 */
const CHILD_RSS_LIMIT_BYTES = 512 * 1024 * 1024;
const RSS_POLL_MS = process.platform === "linux" ? 100 : 250;

const busyError = () => new MailError("rate_limited", "Too many PDF attachments are being read right now. Try again in a few seconds.");

export function createPdfPool(options: PdfPoolOptions = {}): PdfPool {
  const maxRunning = options.maxRunning ?? 2;
  const maxAdmitted = options.maxAdmitted ?? 8;
  const maxAdmittedBytes = options.maxAdmittedBytes ?? 64 * 1024 * 1024;
  const run = options.run ?? runPdfChild;
  let admitted = 0;
  let admittedBytes = 0;
  let running = 0;
  const waiting: (() => void)[] = [];

  // A slot is handed over by counting it here, so several waiters woken at once cannot overrun maxRunning.
  const wake = () => {
    while (running < maxRunning && waiting.length > 0) {
      running += 1;
      waiting.shift()!();
    }
  };

  return {
    get stats() {
      return { admitted, admittedBytes, running, waiting: waiting.length };
    },
    admit(reservedBytes) {
      const reserved = Math.max(0, Math.floor(reservedBytes));
      if (admitted >= maxAdmitted || (admitted > 0 && admittedBytes + reserved > maxAdmittedBytes)) throw busyError();
      admitted += 1;
      admittedBytes += reserved;
      let held = reserved;
      let released = false;
      return {
        resize(bytes) {
          if (released) return;
          const next = Math.max(0, Math.floor(bytes));
          admittedBytes += next - held;
          held = next;
        },
        release() {
          if (released) return;
          released = true;
          admitted -= 1;
          admittedBytes -= held;
        },
        async extract(bytes, job, signal) {
          if (released) throw new Error("PDF ticket already released");
          if (!looksLikePdf(bytes)) throw new MailError("parse_error", "The attachment is not a valid PDF.");
          const deadline = Date.now() + job.timeoutMs;
          const controller = new AbortController();
          const onAbort = () => controller.abort();
          signal?.addEventListener("abort", onAbort, { once: true });
          try {
            if (signal?.aborted) throw cancelledError();
            if (running >= maxRunning || waiting.length > 0) await waitForSlot(deadline, controller.signal);
            else running += 1;
            try {
              const remaining = deadline - Date.now();
              if (remaining <= 0) throw busyError();
              return await run(bytes, { maxPages: job.maxPages, maxChars: job.maxChars, timeoutMs: remaining }, controller.signal);
            } finally {
              running -= 1;
              wake();
            }
          } finally {
            signal?.removeEventListener("abort", onAbort);
          }
        },
      };
    },
  };

  function waitForSlot(deadline: number, signal: AbortSignal): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const entry = () => {
        cleanup();
        resolve();
      };
      const leave = (err: MailError) => {
        cleanup();
        const at = waiting.indexOf(entry);
        if (at >= 0) waiting.splice(at, 1);
        reject(err);
      };
      const onAbort = () => leave(cancelledError());
      const timer = setTimeout(() => leave(busyError()), Math.max(0, deadline - Date.now()));
      const cleanup = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
      };
      signal.addEventListener("abort", onAbort, { once: true });
      waiting.push(entry);
    });
  }
}

function cancelledError(): MailError {
  return new MailError("cancelled", "The request was cancelled.");
}

/** The pool get_attachment uses unless a test injects one. */
export const defaultPdfPool: PdfPool = createPdfPool();

export function looksLikePdf(bytes: Uint8Array): boolean {
  // The header may follow up to 1 KB of junk (PDF 1.7, Annex H.3).
  return Buffer.from(bytes.subarray(0, 1024)).includes("%PDF-");
}

interface ChildOptions {
  heapMb?: number;
  rssLimitBytes?: number;
}

/**
 * Extracts text in a separate Node process, so a hostile PDF cannot block the
 * server's event loop or take its memory. The process gets a heap limit, a
 * resident-memory watchdog and the remaining time budget, and is killed with
 * SIGKILL on any of them. It gets no environment variables. Failures reject
 * with MailError("parse_error").
 */
export function runPdfChild(
  bytes: Uint8Array,
  job: { maxPages: number; maxChars: number; timeoutMs: number },
  signal: AbortSignal,
  childOptions: ChildOptions = {},
): Promise<PdfText> {
  const rssLimit = childOptions.rssLimitBytes ?? CHILD_RSS_LIMIT_BYTES;
  return new Promise((resolve, reject) => {
    const entry = childEntry();
    let child: ChildProcess;
    try {
      child = fork(entry.path, [], {
        execArgv: [...entry.execArgv, `--max-old-space-size=${childOptions.heapMb ?? CHILD_HEAP_MB}`, "--max-semi-space-size=16"],
        env: {},
        serialization: "advanced",
        // pdf.js output is discarded; it could quote document content.
        stdio: ["ignore", "ignore", "ignore", "ipc"],
      });
    } catch {
      reject(new MailError("parse_error", "PDF text could not be extracted."));
      return;
    }
    let settled = false;
    let polling = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(poll);
      signal.removeEventListener("abort", onAbort);
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      fn();
    };
    const fail = (message: string) => finish(() => reject(new MailError("parse_error", message)));
    const timer = setTimeout(() => {
      fail("PDF text extraction took too long and was stopped.");
    }, job.timeoutMs);
    const poll = setInterval(() => {
      if (polling || settled || child.pid === undefined) return;
      polling = true;
      void residentBytes(child.pid).then((rss) => {
        polling = false;
        if (rss !== null && rss > rssLimit) fail("The PDF needs too much memory to extract text from.");
      });
    }, RSS_POLL_MS);
    const onAbort = () => finish(() => reject(cancelledError()));
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
      return;
    }
    child.once("message", (message: unknown) => {
      const reply = message as { ok: true; pages: number; pagesRead: number; text: string; chars: number } | { ok: false; kind: string };
      finish(() => {
        if (reply.ok) {
          resolve({ pages: reply.pages, pagesRead: reply.pagesRead, text: String(reply.text).slice(0, job.maxChars), chars: reply.chars });
        } else reject(new MailError("parse_error", pdfFailure(reply.kind)));
      });
    });
    child.once("error", () => fail("PDF text could not be extracted."));
    // "close" comes after the IPC channel has closed, so a reply sent just before exiting is read first.
    child.once("close", (code, exitSignal) => {
      // V8 aborts on heap exhaustion; the watchdog and timeout use SIGKILL and settle first.
      fail(code !== 0 || exitSignal ? "The PDF is too complex to extract text from." : "PDF text could not be extracted.");
    });
    child.send({ bytes, maxPages: job.maxPages, maxChars: job.maxChars }, (err) => {
      if (err) fail("PDF text could not be extracted.");
    });
  });
}

let resolvedEntry: { path: string; execArgv: string[] } | undefined;
/** dist/mail/pdf-child.js in a build; src/mail/pdf-child.ts (type-stripped) when running from source. */
function childEntry(): { path: string; execArgv: string[] } {
  if (resolvedEntry) return resolvedEntry;
  const js = fileURLToPath(new URL("./pdf-child.js", import.meta.url));
  if (existsSync(js)) resolvedEntry = { path: js, execArgv: [] };
  else {
    const strips = Boolean((process.features as { typescript?: unknown }).typescript);
    resolvedEntry = {
      path: fileURLToPath(new URL("./pdf-child.ts", import.meta.url)),
      execArgv: strips ? ["--disable-warning=ExperimentalWarning"] : ["--experimental-strip-types", "--disable-warning=ExperimentalWarning"],
    };
  }
  return resolvedEntry;
}

/** Resident set size of a process, or null when it cannot be read. */
async function residentBytes(pid: number): Promise<number | null> {
  try {
    if (process.platform === "linux") {
      const status = await readFile(`/proc/${pid}/status`, "utf8");
      const match = /^VmRSS:\s+(\d+)\s+kB/m.exec(status);
      return match ? Number(match[1]) * 1024 : null;
    }
    const output = await new Promise<string>((resolve, reject) => {
      execFile("ps", ["-o", "rss=", "-p", String(pid)], { timeout: 2_000 }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
    });
    const kb = Number(output.trim());
    return Number.isFinite(kb) && kb > 0 ? kb * 1024 : null;
  } catch {
    return null;
  }
}

function pdfFailure(kind: string): string {
  if (kind === "password") return "The PDF is password-protected, so its text cannot be read.";
  if (kind === "invalid") return "The attachment is not a valid PDF.";
  return "PDF text could not be extracted.";
}
