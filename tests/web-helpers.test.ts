import { describe, expect, it } from "vitest";
import { resolveSecureCookies } from "../src/web/cookies.js";
import { shouldSendHsts } from "../src/web/headers.js";
import { mcpUrl } from "../src/web/public-url.js";
import { escapeHtml } from "../src/web/html.js";
import type { IncomingMessage } from "node:http";

describe("web helpers", () => {
  it("escapes HTML and builds an MCP public URL", () => {
    expect(escapeHtml(`<"&'>`)).toBe("&lt;&quot;&amp;&#39;&gt;");
    expect(mcpUrl("https://mcp.openmail.tools")).toBe("https://mcp.openmail.tools/mcp");
    expect(mcpUrl("https://mcp.openmail.tools/mcp")).toBe("https://mcp.openmail.tools/mcp");
    expect(mcpUrl("https://user:pass@evil.example/mcp")).toBeNull();
    expect(mcpUrl(undefined)).toBeNull();
  });

  it("refuses insecure cookies in production and sends HSTS for https public URLs", () => {
    expect(resolveSecureCookies({})).toBe(true);
    expect(resolveSecureCookies({ OPENMAIL_INSECURE_COOKIES: "1", NODE_ENV: "test" })).toBe(false);
    expect(() => resolveSecureCookies({ OPENMAIL_INSECURE_COOKIES: "1", NODE_ENV: "production" })).toThrow(
      /OPENMAIL_INSECURE_COOKIES/,
    );

    const req = { headers: {}, socket: {} } as unknown as IncomingMessage;
    expect(shouldSendHsts(req, { publicUrl: "https://mcp.example" })).toBe(true);
    expect(shouldSendHsts(req, { publicUrl: "http://localhost:8080" })).toBe(false);
    expect(
      shouldSendHsts(
        { headers: { "x-forwarded-proto": "https" }, socket: {} } as unknown as IncomingMessage,
        { trustProxy: true },
      ),
    ).toBe(true);
  });
});
