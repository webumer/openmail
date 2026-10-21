import { describe, expect, it } from "vitest";
import {
  collectThreadIds,
  limitThreadUids,
  parseThreadResponse,
  threadAlgorithm,
  threadContaining,
} from "../src/mail/thread.js";

describe("thread helpers", () => {
  it("selects REFS ahead of REFERENCES", () => {
    expect(threadAlgorithm(["IMAP4rev1", "THREAD=REFERENCES"])).toBe("REFERENCES");
    expect(threadAlgorithm(["thread=refs", "THREAD=REFERENCES"])).toBe("REFS");
    expect(threadAlgorithm(["UIDPLUS"])).toBeNull();
  });

  it("collects unique message ids from the reference chain", () => {
    expect(collectThreadIds({
      messageId: "<child@example.com>",
      inReplyTo: "<root@example.com>",
      references: "<root@example.com> <mid@example.com>",
    })).toEqual(["<child@example.com>", "<root@example.com>", "<mid@example.com>"]);
    expect(collectThreadIds({ references: ["<a@example.com>", "<b@example.com>"] })).toEqual([
      "<a@example.com>",
      "<b@example.com>",
    ]);
  });

  it("flattens a THREAD response and finds the seed", () => {
    const attributes = [
      [{ type: "ATOM", value: "3" }, { type: "ATOM", value: "6" }, [{ type: "ATOM", value: "4" }]],
      [{ type: "ATOM", value: "8" }],
    ];
    const threads = parseThreadResponse(attributes);
    expect(threads).toEqual([[3, 6, 4], [8]]);
    expect(threadContaining(threads, 4)).toEqual([3, 6, 4]);
    expect(threadContaining(threads, 9)).toBeNull();
    expect(parseThreadResponse(undefined)).toEqual([]);
  });

  it("keeps the seed when a thread is longer than the cap", () => {
    const limited = limitThreadUids([5, 4, 3, 2, 1], 5, 3);
    expect(limited.truncated).toBe(true);
    expect(limited.uids).toEqual([5, 1, 2]);
    expect(limitThreadUids([2, 1], 1, 100).truncated).toBe(false);
  });
});
