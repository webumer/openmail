import { describe, expect, it } from "vitest";
import { authorizeRequest, hashApiKeys, matchApiKey, readBearerToken } from "../src/server/auth.js";
import { SlidingWindowRateLimit } from "../src/server/rate-limit.js";
import { UNTRUSTED_CONTENT_WARNING } from "../src/mail/constants.js";
import { toolDescription, listAccountsInput, readMessageInput, searchMessagesInput } from "../src/tools/schemas.js";

describe("api key hashing", () => {
  it("matches a bearer token against SHA-256 hashes and rejects everything else", () => {
    const hashes = hashApiKeys(" alpha , ,beta ");
    expect(hashes).toHaveLength(2);
    expect(hashes[0]?.toString("utf8")).not.toContain("alpha");
    expect(matchApiKey("alpha", hashes)).toBe(hashes[0]?.toString("hex"));
    expect(matchApiKey("beta", hashes)).toBe(hashes[1]?.toString("hex"));
    expect(matchApiKey("nope", hashes)).toBeNull();
    expect(matchApiKey("alpha", [])).toBeNull();
    expect(hashApiKeys(undefined)).toEqual([]);
    expect(hashApiKeys(" , ")).toEqual([]);
  });

  it("reads a bearer token and authorizes only a configured key", () => {
    const hashes = hashApiKeys("secret-key");
    expect(readBearerToken(undefined)).toBeNull();
    expect(readBearerToken("Basic secret-key")).toBeNull();
    expect(readBearerToken("Bearer")).toBeNull();
    expect(readBearerToken("Bearer secret-key extra")).toBeNull();
    expect(authorizeRequest("bearer secret-key", hashes)).toEqual({
      ok: true,
      keyId: hashes[0]?.toString("hex"),
    });
    expect(authorizeRequest(undefined, hashes)).toEqual({ ok: false });
    expect(authorizeRequest("Bearer wrong-key", hashes)).toEqual({ ok: false });
  });
});

describe("rate limit", () => {
  it("allows 60 hits per key per minute and isolates keys", () => {
    const limiter = new SlidingWindowRateLimit(60, 60_000);
    for (let i = 0; i < 60; i += 1) expect(limiter.allow("key-a", 1_000)).toBe(true);
    expect(limiter.allow("key-a", 1_000)).toBe(false);
    expect(limiter.allow("key-b", 1_000)).toBe(true);
    expect(limiter.allow("key-a", 1_000 + 60_000)).toBe(true);
  });
});

describe("tool schemas", () => {
  it("warns that message content is untrusted and applies search defaults", () => {
    expect(toolDescription("Read.")).toContain(UNTRUSTED_CONTENT_WARNING);
    const parsed = searchMessagesInput.parse({ account: "work" });
    expect(parsed.folder).toBe("INBOX");
    expect(parsed.limit).toBe(20);
    expect(parsed.unread).toBeUndefined();
    expect(listAccountsInput.parse({})).toEqual({});
    expect(readMessageInput.parse({ account: "work", folder: "INBOX", uid: 4 }).uid).toBe(4);
  });

  it("rejects an oversized page and a non-positive uid", () => {
    expect(searchMessagesInput.safeParse({ account: "work", limit: 51 }).success).toBe(false);
    expect(searchMessagesInput.safeParse({ account: "work", limit: 0 }).success).toBe(false);
    expect(readMessageInput.safeParse({ account: "work", folder: "INBOX", uid: 0 }).success).toBe(false);
    expect(searchMessagesInput.safeParse({}).success).toBe(false);
  });
});
