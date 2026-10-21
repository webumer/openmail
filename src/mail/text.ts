import { convert } from "html-to-text";

const HTML_OPTIONS = {
  wordwrap: false as const,
  selectors: [
    { selector: "script", format: "skip" },
    { selector: "style", format: "skip" },
  ],
};

export function htmlToText(html: string): string {
  return convert(html, HTML_OPTIONS).trim();
}

export function capText(text: string, limit: number): { text: string; truncated: boolean } {
  if (!Number.isInteger(limit) || limit < 0) {
    throw new Error("cap limit must be a non-negative integer");
  }
  if (text.length <= limit) return { text, truncated: false };
  let end = limit;
  const tail = text.charCodeAt(end - 1);
  if (end > 0 && tail !== undefined && tail >= 0xd800 && tail <= 0xdbff) end -= 1;
  return { text: text.slice(0, end), truncated: true };
}

/** Prefer a real text/plain part. Convert HTML only when plain text is missing. */
export function selectMessageText(text: string | null | undefined, html: string | false | null | undefined): string {
  if (typeof text === "string" && text.trim().length > 0) return text;
  if (typeof html === "string" && html.trim().length > 0) return htmlToText(html);
  return "";
}

/**
 * Walk parts in order and keep a combined string within `cap`, counting the
 * separator between parts. Later parts become empty once the budget is spent.
 */
export function allocateText(
  parts: readonly string[],
  cap: number,
  separator = "\n\n",
): { parts: string[]; combined: string; truncated: boolean } {
  const kept: string[] = [];
  let remaining = cap;
  let truncated = false;
  for (const part of parts) {
    if (truncated || remaining <= 0) {
      kept.push("");
      truncated = true;
      continue;
    }
    const sep = kept.some((piece) => piece.length > 0) ? separator : "";
    if (sep.length >= remaining) {
      kept.push("");
      truncated = true;
      remaining = 0;
      continue;
    }
    const room = remaining - sep.length;
    if (part.length <= room) {
      kept.push(part);
      remaining -= sep.length + part.length;
    } else {
      kept.push(capText(part, room).text);
      remaining = 0;
      truncated = true;
    }
  }
  const combined = kept.filter((part) => part.length > 0).join(separator);
  return { parts: kept, combined, truncated };
}
