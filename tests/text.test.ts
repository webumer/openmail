import { describe, expect, it } from "vitest";
import { allocateText, capText, htmlToText, selectMessageText } from "../src/mail/text.js";

describe("html and caps", () => {
  it("strips tags, scripts, and styles", () => {
    const text = htmlToText("<style>p{color:red}</style><p>Hello <b>world</b></p><script>ignore-this-token</script>");
    expect(text).toContain("Hello");
    expect(text).toContain("world");
    expect(text).not.toContain("<");
    expect(text).not.toContain("ignore-this-token");
    expect(text).not.toContain("color:red");
  });

  it("prefers plain text and converts HTML only when plain text is missing", () => {
    expect(selectMessageText("plain body", "<p>html body</p>")).toBe("plain body");
    expect(selectMessageText("   ", "<p>html body</p>")).toContain("html body");
    expect(selectMessageText(undefined, false)).toBe("");
  });

  it("caps at the given length and keeps surrogate pairs intact", () => {
    const capped = capText("x".repeat(25_000), 20_000);
    expect(capped.truncated).toBe(true);
    expect(capped.text).toHaveLength(20_000);
    expect(capText("short", 20_000)).toEqual({ text: "short", truncated: false });

    const emoji = `${"a".repeat(19_999)}😀`;
    const cut = capText(emoji, 20_000);
    expect(cut.truncated).toBe(true);
    expect(cut.text).toBe("a".repeat(19_999));
    expect(cut.text).not.toMatch(/[\uD800-\uDBFF]$/);
  });

  it("splits a thread budget across parts in order", () => {
    const budget = allocateText(["a".repeat(20_000), "b".repeat(20_000), "c".repeat(20_000)], 40_000);
    expect(budget.truncated).toBe(true);
    expect(budget.parts[0]).toHaveLength(20_000);
    expect(budget.parts[1]).toHaveLength(19_998);
    expect(budget.parts[2]).toBe("");
    expect(budget.combined.length).toBeLessThanOrEqual(40_000);
    expect(allocateText(["one", "two"], 100)).toEqual({
      parts: ["one", "two"],
      combined: "one\n\ntwo",
      truncated: false,
    });
  });
});
