import { describe, expect, it } from "vitest";
import { parseConfig, resolveOpenMailMode } from "../src/config/index.js";
import { MailError } from "../src/errors.js";

describe("OPENMAIL_MODE", () => {
  it("defaults to multi, keeps a config mode, and lets the env var override it", () => {
    expect(resolveOpenMailMode({})).toBe("multi");
    expect(resolveOpenMailMode({}, "single")).toBe("single");
    expect(resolveOpenMailMode({}, "multi")).toBe("multi");
    expect(resolveOpenMailMode({ OPENMAIL_MODE: "" }, "single")).toBe("single");
    expect(resolveOpenMailMode({ OPENMAIL_MODE: "single" }, "multi")).toBe("single");
    expect(resolveOpenMailMode({ OPENMAIL_MODE: "  Multi " }, "single")).toBe("multi");
    expect(() => resolveOpenMailMode({ OPENMAIL_MODE: "hosted" })).toThrow(/OPENMAIL_MODE/);

    expect(parseConfig({}).mode).toBe("multi");
    expect(parseConfig({ mode: "single" }).mode).toBe("single");
    expect(() => parseConfig({ mode: "nope" })).toThrow(MailError);
  });
});
