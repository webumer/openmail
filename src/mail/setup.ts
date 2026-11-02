import { ok, type ToolSuccess } from "./result.js";

export function setupRequired(tool: string, publicUrl?: string): ToolSuccess<unknown> {
  const url = publicUrl ? `${publicUrl.replace(/\/+$/, "")}/dashboard` : undefined;
  const message = `No mailbox is connected to OpenMail yet. Add one at ${url ?? "the OpenMail dashboard"} (Add mailbox), then try again.${tool === "send_message" ? " Nothing was sent." : ""}`;
  const data = tool === "search_messages" ? { messages: [], next_cursor: null }
    : tool === "send_message" ? { sent: false }
    : tool.startsWith("list_") ? [] : null;
  return { ...ok(data, { warnings: [message] }), setup_required: true, message, ...(url ? { dashboard_url: url } : {}) };
}
