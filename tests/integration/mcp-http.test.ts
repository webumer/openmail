import { once } from "node:events";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterAll, describe, expect, it } from "vitest";
import { parseConfig } from "../../src/config/index.js";
import { UNTRUSTED_CONTENT_WARNING } from "../../src/mail/constants.js";
import { createImapGateway } from "../../src/mail/index.js";
import { createSmtpGateway } from "../../src/mail/smtp-gateway.js";
import { createOpenMailServer, hashApiKeys } from "../../src/server/index.js";
import { createMemorySendRecorder } from "../../src/services/send-log.js";
import { ConfigCredentialStore } from "../../src/store/index.js";

const KEY = "integration-test-key";

/**
 * Bearer rejection and /healthz are covered in tests/http.test.ts.
 * This file only exercises streamable MCP tool list/call against GreenMail config.
 */
describe("MCP HTTP tools", () => {
  let server: Server;
  let port = 0;

  afterAll(async () => {
    if (!server) return;
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  });

  it("lists and calls tools with a valid key against the configured store", async () => {
    port = await start();
    const base = `http://127.0.0.1:${port}`;

    const client = new Client({ name: "openmail-integration", version: "0.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${KEY}` } },
    });
    await client.connect(transport);
    try {
      const listed = await client.listTools();
      expect(listed.tools.map((tool) => tool.name).sort()).toEqual([
        "list_accounts",
        "list_folders",
        "read_message",
        "read_thread",
        "search_messages",
        "send_message",
      ]);
      for (const tool of listed.tools) {
        expect(tool.description ?? "").toContain(UNTRUSTED_CONTENT_WARNING);
      }

      const result = await client.callTool({ name: "list_accounts", arguments: {} });
      const content = result.content as { type: string; text?: string }[];
      const text = content.find((block) => block.type === "text");
      expect(text?.type).toBe("text");
      if (!text?.text) return;
      const parsed = JSON.parse(text.text) as {
        ok: boolean;
        data: { id: string; email: string; imap_host: string }[];
        truncated: boolean;
        warnings: unknown[];
      };
      expect(parsed).toMatchObject({
        ok: true,
        truncated: false,
        warnings: ["This connection is read-only"],
      });
      expect(parsed.data).toEqual([
        expect.objectContaining({ id: "test", email: "test@example.com", imap_host: "127.0.0.1" }),
      ]);
      expect(text.text).not.toMatch(/password/i);
      expect(text.text).not.toContain(KEY);
    } finally {
      await client.close();
    }
  });

  async function start(): Promise<number> {
    const config = parseConfig({
      allow_insecure_localhost: true,
      accounts: [
        {
          id: "test",
          label: "Test",
          email: "test@example.com",
          preset: "custom",
          password_env: "OPENMAIL_ACCT_TEST_PASSWORD",
          username: "test",
          imap_host: "127.0.0.1",
          imap_port: 13143,
          imap_secure: false,
          smtp_host: "127.0.0.1",
          smtp_port: 13025,
          smtp_secure: false,
        },
      ],
    });
    server = createOpenMailServer({
      store: new ConfigCredentialStore(config, {}),
      imap: createImapGateway(),
      smtp: createSmtpGateway(),
      sends: createMemorySendRecorder(),
      apiKeyHashes: hashApiKeys(KEY),
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    return (server.address() as AddressInfo).port;
  }
});
