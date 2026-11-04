import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CallToolRequestSchema, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { setupRequired } from "../mail/setup.js";
import { recordMetric, TOOL_NAMES, type MetricRecorder } from "../services/metrics.js";
import type { CredentialStore } from "../store/types.js";
import { fail } from "../mail/result.js";
import { toCallToolResult } from "./result.js";

export interface CallGuardDeps {
  store: Pick<CredentialStore, "listAccounts">;
  userId: string;
  publicUrl?: string;
  metrics?: MetricRecorder;
}

type RequestHandler = (request: unknown, extra: unknown) => Promise<unknown>;

/**
 * Prefixes some MCP hosts put in front of a tool name (for example
 * "openmail.list_folders" or "mcp__openmail__list_folders"). The published
 * tool names are unchanged; these are only accepted on tools/call.
 */
const NAME_PREFIXES = [/^mcp__openmail__/i, /^openmail(?:\.|__|_|:|\/)/i];

const TOOL_LIST = TOOL_NAMES.join(", ");

export function resolveToolName(name: string): (typeof TOOL_NAMES)[number] | null {
  const known = (candidate: string) =>
    (TOOL_NAMES as readonly string[]).includes(candidate) ? (candidate as (typeof TOOL_NAMES)[number]) : null;
  const direct = known(name);
  if (direct) return direct;
  for (const prefix of NAME_PREFIXES) {
    if (prefix.test(name)) {
      const stripped = known(name.replace(prefix, ""));
      if (stripped) return stripped;
    }
  }
  return null;
}

/** Client-supplied text echoed in an error: printable ASCII only, clipped. */
function displayName(name: string): string {
  const clean = name.replace(/[^\x20-\x7e]/g, "?");
  return clean.length > 80 ? `${clean.slice(0, 80)}...` : clean;
}

export function unknownToolResult(name: string, hasMailbox: boolean, publicUrl?: string): CallToolResult {
  const dashboard = publicUrl ? `${publicUrl.replace(/\/+$/, "")}/dashboard` : undefined;
  const setup = hasMailbox
    ? ""
    : ` No mailbox is connected to OpenMail yet. Add one at ${dashboard ?? "the OpenMail dashboard"} (Add mailbox), then try again.`;
  const message = `OpenMail has no tool named "${displayName(name)}". Available tools: ${TOOL_LIST}. Start with list_accounts.${setup}`;
  const body = {
    ...fail("unknown_tool", message),
    available_tools: [...TOOL_NAMES],
    ...(hasMailbox ? {} : { setup_required: true, ...(dashboard ? { dashboard_url: dashboard } : {}) }),
  };
  return { content: [{ type: "text", text: JSON.stringify(body) }], structuredContent: body, isError: true };
}

function isInputValidationError(result: unknown): result is CallToolResult {
  if (!result || typeof result !== "object") return false;
  const r = result as CallToolResult;
  if (r.isError !== true || r.structuredContent !== undefined) return false;
  const first = r.content?.[0];
  return first?.type === "text" && first.text.includes("Input validation error");
}

/**
 * Wraps the SDK's tools/call handler so that:
 * - an unknown tool name returns a tool error naming the available tools (and
 *   the add-mailbox link when the user has none) instead of "Tool X not found";
 * - a user with no mailbox always gets the setup message, even when the
 *   arguments would fail schema validation (e.g. list_folders without account);
 * - schema validation errors point at list_accounts.
 * The advertised tools/list (names, schemas, annotations) is unchanged.
 */
export function installCallGuard(server: McpServer, deps: CallGuardDeps): void {
  const protocol = server.server as unknown as { _requestHandlers?: Map<string, RequestHandler> };
  const original = protocol._requestHandlers?.get("tools/call");
  if (!original) throw new Error("tools/call handler is not registered; register tools before installing the guard");

  server.server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const requested = request.params.name;
    const name = resolveToolName(requested);
    let hasMailbox = true;
    try {
      hasMailbox = (await deps.store.listAccounts(deps.userId)).length > 0;
    } catch {
      // Fall through to the tool handler, which reports store errors itself.
    }
    if (!name) {
      recordMetric(deps.metrics, { kind: "unknown_tool", name: "mcp", outcome: "not_found" });
      return unknownToolResult(requested, hasMailbox, deps.publicUrl);
    }
    if (!hasMailbox) {
      recordMetric(deps.metrics, { kind: "tool_call", name, outcome: "setup_required", bucket: "<1s" });
      return toCallToolResult(setupRequired(name, deps.publicUrl));
    }
    const forwarded = name === requested ? request : { ...request, params: { ...request.params, name } };
    const result = await original(forwarded, extra);
    if (isInputValidationError(result)) {
      recordMetric(deps.metrics, { kind: "tool_call", name, outcome: "invalid_input", bucket: "<1s" });
      const first = result.content[0] as { type: "text"; text: string };
      return {
        ...result,
        content: [{ type: "text", text: `${first.text} Call list_accounts first to get an account id, then retry with the required fields.` }],
      };
    }
    return result as CallToolResult;
  });
}
