import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { createMailMcpServer } from "../src/tools/register.js";
import { resolveToolName } from "../src/tools/guard.js";
import { createMemorySendRecorder } from "../src/services/send-log.js";
import type { Metric } from "../src/services/metrics.js";
import { TOOL_NAMES } from "../src/services/metrics.js";
import type { AccountSummary } from "../src/store/types.js";
import type { ImapGateway } from "../src/mail/imap-gateway.js";

const forbiddenImap: ImapGateway = {
  async withClient() { throw new Error("must not contact IMAP"); },
  async withMailbox() { throw new Error("must not contact IMAP"); },
  async appendMessage() { throw new Error("must not contact IMAP"); },
};
const smtp = { async verify() {}, async send(): Promise<never> { throw new Error("must not send mail"); } };
const mailbox: AccountSummary = { id: "work", label: "work", email: "fake@example.com", preset: "migadu", imapHost: "imap.migadu.com", sendEnabled: false };

async function connect(accounts: { value: AccountSummary[] }, metrics: Metric[], canSend = false) {
  const server = createMailMcpServer({ store: { listAccounts: async () => accounts.value, getAccount: async () => null },
    imap: forbiddenImap, smtp, sends: createMemorySendRecorder(), userId: "user", canSend, via: "test",
    publicUrl: "https://mail.example.com/", metrics: { record: (m) => metrics.push(m) } });
  const client = new Client({ name: "test", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport); await client.connect(clientTransport);
  return { client, close: async () => { await client.close(); await server.close(); } };
}

const text = (r: unknown) => JSON.stringify((r as { content?: unknown }).content);
const message = (r: unknown) => String(((r as { structuredContent?: { error?: { message?: string } } }).structuredContent?.error?.message) ?? "");

describe("tools/call guard (ChatGPT 'Unknown tool' report)", () => {
  it("advertises the same six tools regardless of mail.send scope or mailbox count", async () => {
    for (const [canSend, value] of [[false, []], [true, []], [false, [mailbox]], [true, [mailbox]]] as const) {
      const { client, close } = await connect({ value: [...value] }, [], canSend);
      try {
        const { tools } = await client.listTools();
        expect(tools.map((t) => t.name)).toEqual([...TOOL_NAMES]);
      } finally { await close(); }
    }
  });

  it("returns the add-mailbox message with no mailbox, even when arguments are missing or invalid", async () => {
    const metrics: Metric[] = [];
    const { client, close } = await connect({ value: [] }, metrics, true);
    try {
      for (const [name, args] of [
        ["list_folders", {}], ["search_messages", { unread: true }], ["read_message", { folder: "INBOX" }],
        ["read_thread", { uid: "x" }], ["send_message", { to: ["fake@example.com"], body: "hi", user_confirmed: false }],
        ["list_accounts", { extra: 1 }],
      ] as const) {
        const result = await client.callTool({ name, arguments: args });
        expect(result.isError, name).toBe(false);
        expect(result.structuredContent).toMatchObject({ ok: true, setup_required: true, dashboard_url: "https://mail.example.com/dashboard" });
        expect(text(result)).toContain("No mailbox is connected");
      }
      expect(metrics).toHaveLength(6);
      expect(metrics.every((m) => m.kind === "tool_call" && m.outcome === "setup_required")).toBe(true);
    } finally { await close(); }
  });

  it("answers an unknown tool with the available tools and the dashboard link when there is no mailbox", async () => {
    const metrics: Metric[] = [];
    const { client, close } = await connect({ value: [] }, metrics);
    try {
      const result = await client.callTool({ name: "get_unread_counts", arguments: {} });
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        ok: false, error: { code: "unknown_tool" }, available_tools: [...TOOL_NAMES],
        setup_required: true, dashboard_url: "https://mail.example.com/dashboard",
      });
      expect(message(result)).toContain('OpenMail has no tool named "get_unread_counts".');
      expect(text(result)).toContain("list_accounts, list_folders");
      expect(text(result)).toContain("No mailbox is connected");
      expect(text(result)).not.toContain("not found");
      expect(metrics).toEqual([{ kind: "unknown_tool", name: "mcp", outcome: "not_found" }]);
    } finally { await close(); }
  });

  it("answers an unknown tool without the setup hint when a mailbox exists, and clips the echoed name", async () => {
    const { client, close } = await connect({ value: [mailbox] }, []);
    try {
      const result = await client.callTool({ name: `x\u0000${"a".repeat(200)}`, arguments: {} });
      expect(result.isError).toBe(true);
      expect(result.structuredContent).not.toHaveProperty("setup_required");
      expect(text(result)).not.toContain("No mailbox");
      expect(text(result)).not.toContain("\\u0000");
      expect(text(result)).toContain("...");
    } finally { await close(); }
  });

  it("accepts host-prefixed tool names on tools/call", async () => {
    for (const name of ["openmail.list_accounts", "openmail_list_accounts", "openmail__list_accounts", "mcp__openmail__list_accounts", "OpenMail:list_accounts"]) {
      expect(resolveToolName(name)).toBe("list_accounts");
    }
    expect(resolveToolName("openmail.delete_message")).toBeNull();
    expect(resolveToolName("list_folder")).toBeNull();
    const { client, close } = await connect({ value: [mailbox] }, []);
    try {
      const result = await client.callTool({ name: "openmail.list_accounts", arguments: {} });
      expect(result.isError).toBe(false);
      expect(result.structuredContent).toMatchObject({ ok: true });
    } finally { await close(); }
  });

  it("keeps schema validation for users with a mailbox and points to list_accounts", async () => {
    const metrics: Metric[] = [];
    const { client, close } = await connect({ value: [mailbox] }, metrics, true);
    try {
      const result = await client.callTool({ name: "list_folders", arguments: {} });
      expect(result.isError).toBe(true);
      expect(text(result)).toContain("Input validation error");
      expect(text(result)).toContain("Call list_accounts first");
      expect(metrics).toEqual([{ kind: "tool_call", name: "list_folders", outcome: "invalid_input", bucket: "<1s" }]);
      const send = await client.callTool({ name: "send_message", arguments: { account: "work", to: ["fake@example.com"], body: "hi", user_confirmed: false } });
      expect(send.isError).toBe(true);
      expect(text(send)).toContain("user_confirmed");
    } finally { await close(); }
  });
});
