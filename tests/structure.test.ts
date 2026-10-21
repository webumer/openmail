import { describe, expect, it } from "vitest";
import { hasAttachments, type BodyNode } from "../src/mail/structure.js";

describe("hasAttachments", () => {
  it("ignores a plain text part and an alternative text/html pair", () => {
    expect(hasAttachments({ type: "text/plain" })).toBe(false);
    const alternative: BodyNode = {
      type: "multipart/alternative",
      childNodes: [{ type: "text/plain" }, { type: "text/html" }],
    };
    expect(hasAttachments(alternative)).toBe(false);
  });

  it("detects a pdf sibling, an attached text part, and an image", () => {
    const mixed: BodyNode = {
      type: "multipart/mixed",
      childNodes: [
        { type: "text/plain" },
        { type: "application/pdf", disposition: "attachment", dispositionParameters: { filename: "note.pdf" } },
      ],
    };
    expect(hasAttachments(mixed)).toBe(true);
    expect(hasAttachments({ type: "text/plain", disposition: "attachment" })).toBe(true);
    expect(hasAttachments({ type: "image/png", id: "<img@example.com>" })).toBe(true);
    expect(hasAttachments(null)).toBe(false);
  });
});
