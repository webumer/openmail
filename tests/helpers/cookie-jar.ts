/** Minimal cookie jar for in-process fetch tests against http://127.0.0.1. */
export class CookieJar {
  private readonly cookies = new Map<string, string>();

  store(response: Response): void {
    const headers = response.headers as Headers & { getSetCookie?: () => string[] };
    const lines =
      typeof headers.getSetCookie === "function"
        ? headers.getSetCookie()
        : splitSetCookie(response.headers.get("set-cookie"));
    for (const line of lines) {
      const part = line.split(";")[0]?.trim();
      if (!part) continue;
      const eq = part.indexOf("=");
      if (eq <= 0) continue;
      const name = part.slice(0, eq);
      const value = part.slice(eq + 1);
      if (value === "") this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }

  header(): string | undefined {
    if (this.cookies.size === 0) return undefined;
    return [...this.cookies.entries()].map(([name, value]) => `${name}=${value}`).join("; ");
  }

  get(name: string): string | undefined {
    return this.cookies.get(name);
  }

  clear(): void {
    this.cookies.clear();
  }
}

function splitSetCookie(header: string | null): string[] {
  if (!header) return [];
  return header.split(/,(?=\s*[A-Za-z_][A-Za-z0-9_]*=)/);
}

export function csrfFromHtml(html: string): string {
  const match = html.match(/name="_csrf"\s+value="([^"]+)"/);
  if (!match?.[1]) throw new Error("CSRF token missing from HTML");
  return match[1];
}

export async function fetchJar(
  jar: CookieJar,
  url: string,
  init: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(init.headers);
  const cookie = jar.header();
  if (cookie) headers.set("cookie", cookie);
  const response = await fetch(url, { ...init, headers, redirect: "manual" });
  jar.store(response);
  return response;
}

export async function readHtml(response: Response): Promise<string> {
  return response.text();
}
