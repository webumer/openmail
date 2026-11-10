import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { MailError } from "../errors.js";

export interface PdfText {
  /** Pages in the document. */
  pages: number;
  /** Pages whose text was read (at most the page limit). */
  pagesRead: number;
  text: string;
}

export interface PdfOptions {
  maxPages: number;
  timeoutMs: number;
  /** Characters to keep; text on later pages is counted but not returned. */
  maxChars: number;
}

/** Heap for one extraction. A PDF that needs more fails with parse_error. */
const WORKER_HEAP_MB = 256;
/** Extractions running at once; later calls wait their turn. */
const MAX_CONCURRENT = 2;

/**
 * Runs in a worker thread so a hostile or huge PDF cannot block the event
 * loop or exhaust the server heap: the worker has its own heap limit and is
 * terminated at the timeout. pdf.js runs with eval and font loading off.
 * Only page counts and text are posted back; error text is reduced to a kind.
 */
// Dynamic import works whether Node evaluates this as CommonJS or as a module (--input-type=module).
const WORKER_SOURCE = `
(async () => {
  const { parentPort, workerData } = await import("node:worker_threads");
  let pdf;
  try {
    const { getDocumentProxy } = await import(workerData.unpdf);
    pdf = await getDocumentProxy(workerData.bytes, {
      isEvalSupported: false,
      disableFontFace: true,
      useSystemFonts: false,
      stopAtErrors: false,
      verbosity: 0,
    });
    const pages = pdf.numPages;
    const pagesRead = Math.min(pages, workerData.maxPages);
    let text = "";
    let chars = 0;
    for (let n = 1; n <= pagesRead; n += 1) {
      const page = await pdf.getPage(n);
      const content = await page.getTextContent();
      let pageText = "";
      for (const item of content.items) {
        if (typeof item.str === "string") pageText += item.str;
        if (item.hasEOL) pageText += "\\n";
      }
      page.cleanup();
      pageText = pageText.trim();
      if (pageText.length === 0) continue;
      chars += (chars > 0 ? 2 : 0) + pageText.length;
      // Keep only what the caller can return; later pages are still counted.
      if (text.length <= workerData.maxChars) text += (text.length > 0 ? "\\n\\n" : "") + pageText;
    }
    parentPort.postMessage({ ok: true, pages, pagesRead, text, chars });
  } catch (err) {
    const name = err && typeof err === "object" ? String(err.name || "") : "";
    parentPort.postMessage({ ok: false, kind: name === "PasswordException" ? "password" : name === "InvalidPDFException" ? "invalid" : "other" });
  } finally {
    try { await pdf?.destroy(); } catch {}
  }
})();
`;

let unpdfUrl: string | undefined;
function unpdfEntry(): string {
  unpdfUrl ??= pathToFileURL(createRequire(import.meta.url).resolve("unpdf")).href;
  return unpdfUrl;
}

let running = 0;
const waiting: (() => void)[] = [];

async function withSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (running >= MAX_CONCURRENT) await new Promise<void>((resolve) => waiting.push(resolve));
  running += 1;
  try {
    return await fn();
  } finally {
    running -= 1;
    waiting.shift()?.();
  }
}

export function looksLikePdf(bytes: Uint8Array): boolean {
  // The header may follow up to 1 KB of junk (PDF 1.7, Annex H.3).
  return Buffer.from(bytes.subarray(0, 1024)).includes("%PDF-");
}

/** Extracts text from a PDF. Failures throw MailError("parse_error"). */
export function extractPdfText(bytes: Uint8Array, options: PdfOptions): Promise<PdfText & { chars: number }> {
  if (!looksLikePdf(bytes)) return Promise.reject(new MailError("parse_error", "The attachment is not a valid PDF."));
  return withSlot(() => runWorker(bytes, options));
}

function runWorker(bytes: Uint8Array, options: PdfOptions): Promise<PdfText & { chars: number }> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const worker = new Worker(WORKER_SOURCE, {
      eval: true,
      workerData: { bytes, unpdf: unpdfEntry(), maxPages: options.maxPages, maxChars: options.maxChars },
      resourceLimits: { maxOldGenerationSizeMb: WORKER_HEAP_MB, maxYoungGenerationSizeMb: 32 },
      stdout: true,
      stderr: true,
    });
    // pdf.js output is discarded; it could quote document content.
    worker.stdout.resume();
    worker.stderr.resume();
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate().catch(() => undefined);
      fn();
    };
    const timer = setTimeout(() => {
      finish(() => reject(new MailError("parse_error", `PDF text extraction took longer than ${options.timeoutMs / 1_000} seconds and was stopped.`)));
    }, options.timeoutMs);
    worker.once("message", (message: { ok: true; pages: number; pagesRead: number; text: string; chars: number } | { ok: false; kind: string }) => {
      finish(() => {
        if (message.ok) resolve({ pages: message.pages, pagesRead: message.pagesRead, text: message.text, chars: message.chars });
        else reject(new MailError("parse_error", pdfFailure(message.kind)));
      });
    });
    worker.once("error", () => finish(() => reject(new MailError("parse_error", "The PDF is too complex to extract text from."))));
    worker.once("exit", () => finish(() => reject(new MailError("parse_error", "PDF text could not be extracted."))));
  });
}

function pdfFailure(kind: string): string {
  if (kind === "password") return "The PDF is password-protected, so its text cannot be read.";
  if (kind === "invalid") return "The attachment is not a valid PDF.";
  return "PDF text could not be extracted.";
}
