import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";

/** Exercise handlers without sockets or any external network access. */
export function httpFake(path: string, options: { method?: string; fields?: Record<string, string>; cookie?: string; ip?: string } = {}) {
  const req = Object.assign(Readable.from(options.fields ? [Buffer.from(new URLSearchParams(options.fields).toString())] : []), {
    method: options.method ?? "GET", url: path,
    headers: { "content-type": "application/x-www-form-urlencoded", ...(options.cookie ? { cookie: options.cookie } : {}) },
    socket: { remoteAddress: options.ip ?? "127.0.0.1" },
  }) as unknown as IncomingMessage;
  const headers = new Map<string, unknown>();
  const state = { status: 0, body: "", headers };
  let finish!: () => void;
  const finished = new Promise<void>((resolve) => { finish = resolve; });
  const response = {
    headersSent: false, writableEnded: false,
    setHeader(name: string, value: unknown) { headers.set(name.toLowerCase(), value); },
    getHeader(name: string) { return headers.get(name.toLowerCase()); },
    writeHead(status: number, values?: Record<string, unknown>) {
      state.status = status;
      this.headersSent = true;
      for (const [name, value] of Object.entries(values ?? {})) headers.set(name.toLowerCase(), value);
      return this;
    },
    end(body?: string | Buffer) { state.body = body?.toString() ?? ""; this.writableEnded = true; finish(); },
  };
  const res = response as unknown as ServerResponse;
  return { req, res, state, finished };
}
