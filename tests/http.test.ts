import { once } from "node:events";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { parseConfig } from "../src/config/index.js";
import { createImapGateway } from "../src/mail/index.js";
import { createSmtpGateway } from "../src/mail/smtp-gateway.js";
import { BODY_LIMIT_BYTES, createOpenMailServer, hashApiKeys } from "../src/server/index.js";
import { createMemorySendRecorder } from "../src/services/send-log.js";
import { ConfigCredentialStore } from "../src/store/index.js";

const KEY = "unit-test-key";

describe("http server", () => {
  let server: Server | undefined;

  afterEach(async () => {
    if (!server) return;
    const closing = server;
    server = undefined;
    await new Promise<void>((resolve, reject) => closing.close((err) => (err ? reject(err) : resolve())));
  });

  it("serves healthz without a key and rejects a missing or wrong bearer", async () => {
    const port = await listen();
    const health = await fetch(`http://127.0.0.1:${port}/healthz`);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ ok: true });

    const missing = await post(port, {});
    expect(missing.status).toBe(401);
    expect(await missing.json()).toEqual({ ok: false, error: { code: "unauthorized", message: "Unauthorized" } });

    const wrongKey = "wrong-key-value";
    const wrong = await post(port, { authorization: `Bearer ${wrongKey}` });
    expect(wrong.status).toBe(401);
    expect(await wrong.text()).not.toContain(wrongKey);
  });

  it("returns 429 after the per-key limit and 413 over 1 MB", async () => {
    const port = await listen({ limit: 2, windowMs: 60_000 });
    const headers = { authorization: `Bearer ${KEY}` };
    expect((await post(port, headers, "{}")).status).not.toBe(429);
    expect((await post(port, headers, "{}")).status).not.toBe(429);
    const limited = await post(port, headers, "{}");
    expect(limited.status).toBe(429);
    expect(await limited.json()).toEqual({ ok: false, error: { code: "rate_limited", message: "Too many requests" } });

    const port2 = await listen();
    const oversized = "x".repeat(BODY_LIMIT_BYTES + 1);
    const tooBig = await post(port2, { authorization: `Bearer ${KEY}` }, oversized);
    expect(tooBig.status).toBe(413);
    expect(await tooBig.text()).not.toContain(KEY);
  });

  async function listen(rateLimit?: { limit: number; windowMs: number }): Promise<number> {
    if (server) {
      const closing = server;
      server = undefined;
      await new Promise<void>((resolve, reject) => closing.close((err) => (err ? reject(err) : resolve())));
    }
    const config = parseConfig({
      allow_insecure_localhost: false,
      accounts: [],
    });
    server = createOpenMailServer({
      store: new ConfigCredentialStore(config),
      imap: createImapGateway(),
      smtp: createSmtpGateway(),
      sends: createMemorySendRecorder(),
      apiKeyHashes: hashApiKeys(KEY),
      ...(rateLimit ? { rateLimit } : {}),
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address() as AddressInfo;
    return address.port;
  }
});

function post(port: number, headers: Record<string, string>, body = "{}"): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
    body,
  });
}
