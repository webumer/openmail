import { request, type RequestOptions } from "node:https";
import type { LookupAddress } from "node:dns";
import { isIP } from "node:net";
import { defaultResolver, isPrivateAddress, type Resolver } from "../mail/address-guard.js";

/**
 * Fetches a Client ID Metadata Document. The URL comes from a stranger, so
 * this is an SSRF surface: https on port 443 only, DNS resolved once and every
 * address must be public, the socket is pinned to the checked address (no
 * DNS rebinding), no redirects, 5 s timeout, 32 KB cap, TLS verified.
 */
export interface FetchedDocument {
  status: number;
  body: string;
  contentType: string;
  /** Seconds from Cache-Control max-age, when present. */
  maxAge?: number;
  noStore?: boolean;
}

export type DocumentFetcher = (url: URL) => Promise<FetchedDocument>;

export const CIMD_MAX_BYTES = 32 * 1024;
export const CIMD_TIMEOUT_MS = 5_000;

export class CimdFetchError extends Error {}

export function createDocumentFetcher(options: { resolve?: Resolver; timeoutMs?: number; maxBytes?: number } = {}): DocumentFetcher {
  const resolve = options.resolve ?? defaultResolver;
  const timeoutMs = options.timeoutMs ?? CIMD_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? CIMD_MAX_BYTES;
  return async (url) => {
    if (url.protocol !== "https:" || (url.port !== "" && url.port !== "443")) {
      throw new CimdFetchError("client_id must be an https URL on port 443");
    }
    const host = url.hostname.replace(/^\[|\]$/g, "");
    let addresses: string[];
    if (isIP(host)) {
      addresses = [host];
    } else {
      try {
        addresses = await resolve(host);
      } catch {
        throw new CimdFetchError("client_id host could not be resolved");
      }
    }
    if (addresses.length === 0 || addresses.some(isPrivateAddress)) {
      throw new CimdFetchError("client_id host must be a public internet address");
    }
    const pinned = addresses[0] as string;
    const family = isIP(pinned) === 6 ? 6 : 4;
    return new Promise<FetchedDocument>((resolveOuter, rejectOuter) => {
      let settled = false;
      const deadline = setTimeout(() => {
        req.destroy();
        reject(new CimdFetchError("client metadata document request timed out"));
      }, timeoutMs);
      const resolvePromise = (doc: FetchedDocument) => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        resolveOuter(doc);
      };
      const reject = (err: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        rejectOuter(err);
      };
      const requestOptions = {
          protocol: "https:",
          hostname: host,
          port: 443,
          path: `${url.pathname}${url.search}`,
          method: "GET",
          ...(isIP(host) ? {} : { servername: host }),
          headers: { accept: "application/json", "user-agent": "OpenMail-OAuth/1.0 (+https://mcp.openmail.tools)" },
          timeout: timeoutMs,
          autoSelectFamily: false,
          lookup: ((_hostname: string, opts: { all?: boolean }, callback: (...args: unknown[]) => void) => {
            if (opts && opts.all) {
              const list: LookupAddress[] = [{ address: pinned, family }];
              callback(null, list);
            } else {
              callback(null, pinned, family);
            }
          }) as never,
        } as RequestOptions;
      const req = request(requestOptions, (res) => {
          const status = res.statusCode ?? 0;
          const chunks: Buffer[] = [];
          let total = 0;
          res.on("data", (chunk: Buffer) => {
            total += chunk.length;
            if (total > maxBytes) {
              res.destroy();
              reject(new CimdFetchError("client metadata document is too large"));
              return;
            }
            chunks.push(chunk);
          });
          res.on("end", () => {
            const cacheControl = String(res.headers["cache-control"] ?? "").toLowerCase();
            const maxAgeMatch = /(?:^|,)\s*max-age=(\d{1,9})/.exec(cacheControl);
            resolvePromise({
              status,
              body: Buffer.concat(chunks).toString("utf8"),
              contentType: String(res.headers["content-type"] ?? ""),
              ...(maxAgeMatch?.[1] ? { maxAge: Number(maxAgeMatch[1]) } : {}),
              ...(/(?:^|,)\s*no-store/.test(cacheControl) ? { noStore: true } : {}),
            });
          });
          res.on("error", () => reject(new CimdFetchError("client metadata document could not be read")));
        },
      );
      req.on("timeout", () => {
        req.destroy();
        reject(new CimdFetchError("client metadata document request timed out"));
      });
      req.on("error", () => reject(new CimdFetchError("client metadata document could not be fetched")));
      req.end();
    });
  };
}
