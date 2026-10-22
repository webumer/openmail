import { describe, expect, it } from "vitest";
import { deriveOAuthConfig, isOurResource, parseScope } from "../src/oauth/config.js";
import { parseRedirectUri, redirectUriAllowed } from "../src/oauth/redirect-uri.js";
import { cleanClientName, parseCimdUrl, resolveCimdClient } from "../src/oauth/clients.js";
import { migrate, openDatabase } from "../src/db/index.js";
import { s256, verifyPkce } from "../src/oauth/tokens.js";
import { createDocumentFetcher } from "../src/oauth/cimd-fetch.js";
import { safeNext } from "../src/web/next.js";

const config = deriveOAuthConfig("https://mcp.openmail.tools")!;

describe("oauth config", () => {
  it("derives issuer, resource and metadata URL from the public URL", () => {
    expect(config).toEqual({
      issuer: "https://mcp.openmail.tools",
      resource: "https://mcp.openmail.tools/mcp",
      resourceMetadataUrl: "https://mcp.openmail.tools/.well-known/oauth-protected-resource/mcp",
    });
    expect(deriveOAuthConfig("http://mcp.openmail.tools")).toBeNull();
    expect(deriveOAuthConfig(undefined)).toBeNull();
    expect(deriveOAuthConfig("https://user:pw@mcp.openmail.tools")).toBeNull();
  });

  it("accepts only our resource", () => {
    expect(isOurResource(config, "https://mcp.openmail.tools/mcp")).toBe(true);
    expect(isOurResource(config, "HTTPS://MCP.OPENMAIL.TOOLS/mcp")).toBe(true);
    expect(isOurResource(config, "https://mcp.openmail.tools")).toBe(true);
    expect(isOurResource(config, "https://mcp.openmail.tools/")).toBe(true);
    expect(isOurResource(config, "https://mcp.openmail.tools/mcp/")).toBe(true);
    expect(isOurResource(config, "https://evil.example/mcp")).toBe(false);
    expect(isOurResource(config, "https://mcp.openmail.tools/other")).toBe(false);
    expect(isOurResource(config, "https://mcp.openmail.tools/mcp#x")).toBe(false);
    expect(isOurResource(config, "https://mcp.openmail.tools/mcp?x=1")).toBe(false);
    expect(isOurResource(config, "http://mcp.openmail.tools/mcp")).toBe(false);
    expect(isOurResource(config, "not a url")).toBe(false);
  });

  it("parses scopes", () => {
    expect(parseScope(undefined)).toEqual({ ok: true, scope: "mail.read" });
    expect(parseScope("mail.read offline_access")).toEqual({ ok: true, scope: "mail.read" });
    expect(parseScope("offline_access")).toEqual({ ok: true, scope: "mail.read" });
    expect(parseScope("mail.write")).toEqual({ ok: false });
    expect(parseScope("openid email")).toEqual({ ok: false });
  });
});

describe("redirect URIs", () => {
  it("accepts https and loopback http only", () => {
    expect(parseRedirectUri("https://claude.ai/api/mcp/auth_callback")).not.toBeNull();
    expect(parseRedirectUri("http://localhost:3118/callback")).not.toBeNull();
    expect(parseRedirectUri("http://127.0.0.1/callback")).not.toBeNull();
    expect(parseRedirectUri("http://[::1]:8080/cb")).not.toBeNull();
    expect(parseRedirectUri("http://evil.example/cb")).toBeNull();
    expect(parseRedirectUri("http://localhost.evil.example/cb")).toBeNull();
    expect(parseRedirectUri("https://claude.ai/cb#frag")).toBeNull();
    expect(parseRedirectUri("https://user:pw@claude.ai/cb")).toBeNull();
    expect(parseRedirectUri("javascript:alert(1)")).toBeNull();
    expect(parseRedirectUri("cursor://anysphere/cb")).toBeNull();
    expect(parseRedirectUri("https://a.example/" + "x".repeat(2100))).toBeNull();
  });

  it("matches exactly, except the port of a loopback redirect", () => {
    const registered = ["https://claude.ai/api/mcp/auth_callback", "http://localhost/callback", "http://127.0.0.1/callback"];
    expect(redirectUriAllowed(registered, "https://claude.ai/api/mcp/auth_callback")).toBe(true);
    expect(redirectUriAllowed(registered, "https://claude.ai/api/mcp/auth_callback/")).toBe(false);
    expect(redirectUriAllowed(registered, "https://claude.ai/api/mcp/auth_callback?x=1")).toBe(false);
    expect(redirectUriAllowed(registered, "https://claude.ai.evil.example/api/mcp/auth_callback")).toBe(false);
    expect(redirectUriAllowed(registered, "http://localhost:3118/callback")).toBe(true);
    expect(redirectUriAllowed(registered, "http://127.0.0.1:54321/callback")).toBe(true);
    expect(redirectUriAllowed(registered, "http://localhost:3118/other")).toBe(false);
    expect(redirectUriAllowed(registered, "http://[::1]:3118/callback")).toBe(false);
    expect(redirectUriAllowed(["https://app.example/cb"], "https://app.example:8443/cb")).toBe(false);
  });
});

describe("login next parameter", () => {
  it("allows only the local authorize endpoint", () => {
    expect(safeNext("/oauth/authorize?client_id=x")).toBe("/oauth/authorize?client_id=x");
    expect(safeNext("https://evil.example/")).toBeUndefined();
    expect(safeNext("//evil.example/oauth/authorize?x")).toBeUndefined();
    expect(safeNext("/oauth/authorize\\@evil.example")).toBeUndefined();
    expect(safeNext("/oauth/authorize/../../dashboard?x")).toBeUndefined();
    expect(safeNext("/dashboard")).toBeUndefined();
    expect(safeNext("/oauth/authorize?x\r\nSet-Cookie: a=b")).toBeUndefined();
    expect(safeNext(undefined)).toBeUndefined();
  });
});

describe("CIMD client ids", () => {
  it("requires an https URL with a path and no tricks", () => {
    expect(parseCimdUrl("https://claude.ai/oauth/claude-code-client-metadata")).not.toBeNull();
    expect(parseCimdUrl("https://chatgpt.com/oauth/client.json")).not.toBeNull();
    expect(parseCimdUrl("https://example.com/")).toBeNull();
    expect(parseCimdUrl("https://example.com")).toBeNull();
    expect(parseCimdUrl("http://example.com/client.json")).toBeNull();
    expect(parseCimdUrl("https://example.com:8443/client.json")).toBeNull();
    expect(parseCimdUrl("https://example.com/a/../client.json")).toBeNull();
    expect(parseCimdUrl("https://example.com/client.json?x=1")).toBeNull();
    expect(parseCimdUrl("https://example.com/client.json#x")).toBeNull();
    expect(parseCimdUrl("https://u:p@example.com/client.json")).toBeNull();
  });

  it("strips control and bidi characters from names", () => {
    expect(cleanClientName("Claude\u202e  Code\u0000")).toBe("Claude Code");
    expect(cleanClientName("   ")).toBeNull();
    expect(cleanClientName(42)).toBeNull();
    expect(cleanClientName("x".repeat(300))?.length).toBe(100);
  });

  it("refuses to fetch metadata from private addresses", async () => {
    const fetcher = createDocumentFetcher({ resolve: async () => ["10.0.0.5"] });
    await expect(fetcher(new URL("https://internal.example/client.json"))).rejects.toThrow(/public internet address/);
    const metadata = createDocumentFetcher({ resolve: async () => ["169.254.169.254"] });
    await expect(metadata(new URL("https://meta.example/client.json"))).rejects.toThrow(/public internet address/);
    const mixed = createDocumentFetcher({ resolve: async () => ["93.184.216.34", "127.0.0.1"] });
    await expect(mixed(new URL("https://mixed.example/client.json"))).rejects.toThrow(/public internet address/);
    const literal = createDocumentFetcher();
    await expect(literal(new URL("https://127.0.0.1/client.json"))).rejects.toThrow(/public internet address/);
    await expect(literal(new URL("https://example.com:8443/client.json"))).rejects.toThrow(/port 443/);
  });
});

describe("PKCE", () => {
  it("verifies S256 only", () => {
    const verifier = "a".repeat(43);
    const challenge = s256(verifier);
    expect(verifyPkce(verifier, challenge)).toBe(true);
    expect(verifyPkce("b".repeat(43), challenge)).toBe(false);
    expect(verifyPkce(verifier, verifier)).toBe(false);
    expect(verifyPkce("short", s256("short"))).toBe(false);
  });
});

describe("CIMD cache", () => {
  it("prunes expired, grantless CIMD clients when a new one is cached", async () => {
    const db = openDatabase(":memory:");
    migrate(db);
    const doc = (id: string) => ({
      status: 200,
      body: JSON.stringify({ client_id: id, client_name: "A", redirect_uris: ["https://a.example/cb"] }),
      maxAge: null,
      noStore: false,
    });
    const fetcher = async (u: URL) => doc(u.toString());
    const t0 = Date.parse("2026-01-01T00:00:00Z");
    await resolveCimdClient(db, "https://a.example/one", fetcher as never, t0);
    expect(db.prepare("SELECT COUNT(*) AS n FROM oauth_clients").get()).toEqual({ n: 1 });
    await resolveCimdClient(db, "https://a.example/two", fetcher as never, t0 + 2 * 60 * 60 * 1000);
    const ids = db.prepare("SELECT id FROM oauth_clients ORDER BY id").all();
    expect(ids).toEqual([{ id: "https://a.example/two" }]);
    db.close();
  });
});
