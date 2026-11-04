import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { ToolResult } from "../mail/result.js";

export function toCallToolResult(result: ToolResult<unknown>): CallToolResult {
  const payload = {
    content: [{ type: "text" as const, text: JSON.stringify(result) }],
    structuredContent: result as unknown as Record<string, unknown>,
  };
  return result.ok ? { ...payload, isError: false } : { ...payload, isError: true };
}
