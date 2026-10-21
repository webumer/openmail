import { describe, expect, it } from "vitest";
import { MailError } from "../src/errors.js";
import { decodeCursor, encodeCursor } from "../src/mail/cursor.js";

describe("cursors", () => {
  it("round-trips an offset and a uid boundary", () => {
    const encoded = encodeCursor({ v: 1, offset: 20, uid: 400 });
    expect(encoded).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
    expect(decodeCursor(encoded)).toEqual({ v: 1, offset: 20, uid: 400 });
    expect(decodeCursor(encodeCursor({ v: 1, offset: 0, uid: null }))).toEqual({ v: 1, offset: 0, uid: null });
  });

  it("rejects malformed cursors", () => {
    expect(() => decodeCursor("")).toThrow(MailError);
    expect(() => decodeCursor("abc")).toThrow(MailError);
    expect(() => decodeCursor("@@@@")).toThrow(MailError);
    const badJson = Buffer.from("[]", "utf8").toString("base64");
    expect(() => decodeCursor(badJson)).toThrow(/not an object/);
    const missing = Buffer.from(JSON.stringify({ v: 1, offset: 1 }), "utf8").toString("base64");
    expect(() => decodeCursor(missing)).toThrow(/uid/);
    const negative = Buffer.from(JSON.stringify({ v: 1, offset: -1, uid: null }), "utf8").toString("base64");
    expect(() => decodeCursor(negative)).toThrow(/offset/);
    const version = Buffer.from(JSON.stringify({ v: 2, offset: 0, uid: null }), "utf8").toString("base64");
    expect(() => decodeCursor(version)).toThrow(/version/);
    const zeroUid = Buffer.from(JSON.stringify({ v: 1, offset: 0, uid: 0 }), "utf8").toString("base64");
    expect(() => decodeCursor(zeroUid)).toThrow(/uid/);
  });
});
