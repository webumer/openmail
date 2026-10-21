import { describe, expect, it } from "vitest";
import { renderMarkdown } from "../src/web/markdown.js";

describe("markdown subset", () => {
  it("renders headings, lists, tables, inline code and safe links", () => {
    const html = renderMarkdown("# Title\n\nSee **bold** and `a<b>` at https://example.com/x.\n\n- one\n- [two](https://example.org)\n\n| A | B |\n|---|---|\n| 1 | *2* |\n");
    expect(html).toContain("<h1>Title</h1>");
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain("<code>a&lt;b&gt;</code>");
    expect(html).toContain('<a href="https://example.com/x">https://example.com/x</a>.');
    expect(html).toContain('<li><a href="https://example.org">two</a></li>');
    expect(html).toContain("<th>A</th>");
    expect(html).toContain("<td><em>2</em></td>");
  });

  it("escapes raw HTML and refuses javascript links", () => {
    const html = renderMarkdown('<script>alert(1)</script> [x](javascript:alert(1)) "q"');
    expect(html).not.toContain("<script>");
    expect(html).not.toContain('href="javascript');
    expect(html).toContain("&lt;script&gt;");
  });
});
