/**
 * Stands in for the server in the shutdown test: installs the shutdown hooks,
 * starts a PDF child that would run for 30 s, prints its pid and signals itself.
 */
import { installPdfShutdownHooks, startPdfChild } from "../../src/mail/pdf.js";
import { simplePdf } from "./pdf.js";

installPdfShutdownHooks();
const signal = process.argv[2] as NodeJS.Signals;
const run = startPdfChild(simplePdf(["a"]), { maxPages: 1, maxChars: 10, timeoutMs: 30_000 }, new AbortController().signal);
run.result.catch(() => undefined);
// Keep the server alive past the signal, as an HTTP listener would.
setInterval(() => undefined, 1_000);
process.stdout.write(`child ${run.pid}\n`, () => process.kill(process.pid, signal));
