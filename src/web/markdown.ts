import { escapeHtml } from "./html.js";

/**
 * Small Markdown subset for pages we write ourselves (the reviewer guide):
 * headings, paragraphs, bullet lists, pipe tables, **bold**, *italic*,
 * `code`, [text](url) and bare https URLs. Everything is escaped first, so
 * raw HTML in the source is shown as text. Only http(s) and mailto links.
 */
export function renderMarkdown(source: string): string {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    if (line.trim() === "") {
      i += 1;
      continue;
    }
    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) {
      const level = (heading[1] ?? "#").length;
      out.push(`<h${level}>${inline(heading[2] ?? "")}</h${level}>`);
      i += 1;
      continue;
    }
    if (/^\s*[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i] ?? "")) {
        items.push(`<li>${inline((lines[i] ?? "").replace(/^\s*[-*]\s+/, ""))}</li>`);
        i += 1;
      }
      out.push(`<ul>${items.join("")}</ul>`);
      continue;
    }
    if (/^\s*\|/.test(line)) {
      const rows: string[][] = [];
      while (i < lines.length && /^\s*\|/.test(lines[i] ?? "")) {
        const cells = (lines[i] ?? "").trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
        if (!cells.every((c) => /^:?-{2,}:?$/.test(c))) rows.push(cells);
        i += 1;
      }
      const [head, ...body] = rows;
      const th = (head ?? []).map((c) => `<th>${inline(c)}</th>`).join("");
      const tb = body.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`).join("");
      out.push(`<div class="table"><table><thead><tr>${th}</tr></thead><tbody>${tb}</tbody></table></div>`);
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && (lines[i] ?? "").trim() !== "" && !/^(#{1,4}\s|\s*[-*]\s|\s*\|)/.test(lines[i] ?? "")) {
      para.push(lines[i] ?? "");
      i += 1;
    }
    out.push(`<p>${inline(para.join(" "))}</p>`);
  }
  return out.join("\n");
}

function inline(text: string): string {
  const codes: string[] = [];
  let html = escapeHtml(text).replace(/`([^`]+)`/g, (_m, code: string) => {
    codes.push(`<code>${code}</code>`);
    return `\u0000${codes.length - 1}\u0000`;
  });
  html = html.replace(/\[([^\]]+)\]\(((?:https?:\/\/|mailto:)[^)\s]+)\)/g, '<a href="$2">$1</a>');
  html = html.replace(/(^|[\s(])(https:\/\/[^\s<)]+[^\s<).,;:])/g, '$1<a href="$2">$2</a>');
  html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/(^|[^*])\*([^*\s][^*]*)\*/g, "$1<em>$2</em>");
  return html.replace(/\u0000(\d+)\u0000/g, (_m, n: string) => codes[Number(n)] ?? "");
}
