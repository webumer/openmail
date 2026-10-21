/** Public MCP endpoint shown in the dashboard. Userinfo is never displayed. */
export function mcpUrl(publicUrl: string | undefined): string | null {
  if (!publicUrl?.trim()) return null;
  let url: URL;
  try {
    url = new URL(publicUrl.trim());
  } catch {
    return null;
  }
  if (url.username || url.password) return null;
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  url.hash = "";
  url.search = "";
  const path = url.pathname.replace(/\/+$/, "");
  url.pathname = path.toLowerCase().endsWith("/mcp") ? path || "/mcp" : `${path}/mcp`.replace(/\/{2,}/g, "/");
  return url.toString();
}
