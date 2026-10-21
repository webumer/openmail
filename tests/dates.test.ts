import { describe, expect, it } from "vitest";
import { normalizeDate } from "../src/mail/dates.js";

describe("normalizeDate", () => {
  it("converts a numeric offset into a UTC instant and +HH:MM", () => {
    const date = normalizeDate("Wed, 21 Oct 2026 18:19:00 +0500");
    expect(date).toEqual({
      utc: "2026-10-21T13:19:00.000Z",
      original_offset: "+05:00",
      original: "Wed, 21 Oct 2026 18:19:00 +0500",
    });
  });

  it("accepts a colon offset, a negative offset, and zero", () => {
    expect(normalizeDate("Wed, 21 Oct 2026 18:19:00 +05:30")?.original_offset).toBe("+05:30");
    expect(normalizeDate("Wed, 21 Oct 2026 18:19:00 +05:30")?.utc).toBe("2026-10-21T12:49:00.000Z");
    expect(normalizeDate("Wed, 21 Oct 2026 18:19:00 -0700")).toMatchObject({
      utc: "2026-10-22T01:19:00.000Z",
      original_offset: "-07:00",
    });
    expect(normalizeDate("Wed, 21 Oct 2026 18:19:00 +0000")).toMatchObject({
      utc: "2026-10-21T18:19:00.000Z",
      original_offset: "+00:00",
    });
  });

  it("maps GMT, Z, and obsolete named zones", () => {
    expect(normalizeDate("Wed, 21 Oct 2026 18:19:00 GMT")).toMatchObject({
      utc: "2026-10-21T18:19:00.000Z",
      original_offset: "+00:00",
    });
    expect(normalizeDate("2026-10-21T13:19:00.000Z")?.original_offset).toBe("+00:00");
    expect(normalizeDate("Wed, 21 Oct 2026 18:19:00 EST")).toMatchObject({
      utc: "2026-10-21T23:19:00.000Z",
      original_offset: "-05:00",
    });
  });

  it("ignores a parenthetical comment after the offset", () => {
    const date = normalizeDate("Wed, 21 Oct 2026 18:19:00 +0500 (PKT)");
    expect(date).toMatchObject({
      utc: "2026-10-21T13:19:00.000Z",
      original_offset: "+05:00",
      original: "Wed, 21 Oct 2026 18:19:00 +0500 (PKT)",
    });
  });

  it("prefers the raw header over a Date instant", () => {
    const date = normalizeDate(new Date("2020-01-01T00:00:00.000Z"), "Wed, 21 Oct 2026 18:19:00 +0500");
    expect(date?.utc).toBe("2026-10-21T13:19:00.000Z");
    expect(date?.original_offset).toBe("+05:00");
  });

  it("returns a UTC instant with a null offset when only a Date is known", () => {
    const input = new Date("2026-10-21T13:19:00.000Z");
    expect(normalizeDate(input)).toEqual({
      utc: "2026-10-21T13:19:00.000Z",
      original_offset: null,
      original: "2026-10-21T13:19:00.000Z",
    });
  });

  it("rejects an impossible numeric offset and unparseable input", () => {
    expect(normalizeDate("Wed, 21 Oct 2026 18:19:00 +0560")).toBeNull();
    expect(normalizeDate("not a date")).toBeNull();
    expect(normalizeDate(null)).toBeNull();
    expect(normalizeDate(undefined)).toBeNull();
    expect(normalizeDate(new Date("invalid"))).toBeNull();
  });
});
