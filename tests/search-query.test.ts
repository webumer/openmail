import { describe, expect, it } from "vitest";
import { buildSearchQuery } from "../src/mail/search-query.js";
import { MailError } from "../src/errors.js";

describe("buildSearchQuery", () => {
  it("maps filters onto IMAP search keys and matches everything when empty", () => {
    expect(buildSearchQuery({})).toEqual({ all: true });
    expect(buildSearchQuery({ from: " ada@example.com ", unread: true, text: "hello" })).toEqual({
      from: "ada@example.com",
      seen: false,
      text: "hello",
    });
    expect(buildSearchQuery({ unread: false }).seen).toBeUndefined();
    const since = buildSearchQuery({ since: "2026-10-21", before: "2026-10-22" });
    expect(since.since).toEqual(new Date("2026-10-21T00:00:00.000Z"));
    expect(since.before).toEqual(new Date("2026-10-22T00:00:00.000Z"));
  });

  it("rejects an unparseable date", () => {
    expect(() => buildSearchQuery({ since: "yesterday" })).toThrow(MailError);
  });
});
