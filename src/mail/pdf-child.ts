/**
 * Child process entry for PDF text extraction (started by pdf.ts). It reads
 * one job from IPC, replies once and exits. argv[2] is its own deadline in
 * milliseconds: past it, or once the server is gone, it kills itself. It has no project imports and only
 * erasable TypeScript, so tests can run it from source with Node's type
 * stripping. Font loading is off (the bundled pdf.js 5 has no eval-based font
 * compiler). Only page counts and text are sent back; error text is reduced to
 * a kind.
 */
import { writeFileSync } from "node:fs";
import { Worker } from "node:worker_threads";

interface Job {
  bytes: Uint8Array;
  maxPages: number;
  /** Characters to send back; text past this is counted, not kept. */
  maxChars: number;
}

type Reply =
  | { ok: true; pages: number; pagesRead: number; text: string; chars: number }
  | { ok: false; kind: "password" | "invalid" | "other" };

interface TextItem {
  str?: unknown;
  hasEOL?: unknown;
}

// On Linux, ask the kernel to pick this process first if memory runs out, so a
// decompression bomb kills the parser rather than the server.
try {
  writeFileSync("/proc/self/oom_score_adj", "1000");
} catch {
  // Not Linux, or not permitted.
}

// The server normally kills this process. In case it cannot (it crashed, or
// was killed itself), exit when the IPC channel closes, and run a watchdog
// thread that SIGKILLs the process at the deadline or when the parent changes.
// The watchdog has its own event loop, so it fires even while a synchronous
// decode blocks this thread; "disconnect" only fires between tasks.
const parentPid = process.ppid;
if (!process.connected) process.exit(1);
process.once("disconnect", () => process.exit(1));
const deadlineMs = Number(process.argv[2]);
const watchdog = new Worker(
  `const { workerData } = require("node:worker_threads");
  const end = Date.now() + workerData.deadlineMs;
  setInterval(() => {
    if (Date.now() >= end || process.ppid !== workerData.parentPid) process.kill(process.pid, "SIGKILL");
  }, 100);`,
  {
    eval: true,
    workerData: { deadlineMs: Number.isFinite(deadlineMs) && deadlineMs > 0 ? deadlineMs : 60_000, parentPid },
    env: {},
    resourceLimits: { maxOldGenerationSizeMb: 16, maxYoungGenerationSizeMb: 4 },
    stdout: true,
    stderr: true,
  },
);
watchdog.unref();

process.once("message", (message: unknown) => {
  void extract(message as Job).then((reply) => {
    if (process.send) process.send(reply, () => process.exit(0));
    else process.exit(0);
  });
});

async function extract(job: Job): Promise<Reply> {
  let pdf: { numPages: number; getPage(n: number): Promise<PdfPage>; destroy(): Promise<void> } | undefined;
  try {
    const { getDocumentProxy } = await import("unpdf");
    // pdf.js refuses a Buffer; IPC may deliver one. Pass a plain view of the same memory.
    const data = new Uint8Array(job.bytes.buffer, job.bytes.byteOffset, job.bytes.byteLength);
    pdf = (await getDocumentProxy(data, {
      disableFontFace: true,
      useSystemFonts: false,
      stopAtErrors: false,
      verbosity: 0,
    })) as unknown as typeof pdf;
    const doc = pdf!;
    const pages = doc.numPages;
    const pagesRead = Math.min(pages, job.maxPages);
    let text = "";
    let chars = 0;
    for (let n = 1; n <= pagesRead; n += 1) {
      const page = await doc.getPage(n);
      const content = await page.getTextContent();
      let pageText = "";
      for (const item of content.items as TextItem[]) {
        if (typeof item.str === "string") pageText += item.str;
        if (item.hasEOL) pageText += "\n";
      }
      page.cleanup();
      pageText = pageText.trim();
      if (pageText.length === 0) continue;
      const separator = chars > 0 ? "\n\n" : "";
      chars += separator.length + pageText.length;
      // Keep only what the caller can return, even when one page is huge.
      const room = job.maxChars - text.length;
      if (room > 0) text += (separator + pageText).slice(0, room);
    }
    return { ok: true, pages, pagesRead, text, chars };
  } catch (err) {
    const name = err && typeof err === "object" ? String((err as { name?: unknown }).name ?? "") : "";
    return { ok: false, kind: name === "PasswordException" ? "password" : name === "InvalidPDFException" ? "invalid" : "other" };
  } finally {
    try {
      await pdf?.destroy();
    } catch {
      // The process exits next.
    }
  }
}

interface PdfPage {
  getTextContent(): Promise<{ items: unknown[] }>;
  cleanup(): void;
}
