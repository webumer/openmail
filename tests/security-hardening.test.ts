import { once } from "node:events";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { FetchQueryObject, ImapFlowOptions } from "imapflow";
import { afterEach, describe, expect, it } from "vitest";
import { runAdmin } from "../src/cli/admin.js";
import { generateTestMasterKey, loadMasterKey, openPassword, sealPassword } from "../src/crypto/index.js";
import { migrate, openDatabase } from "../src/db/index.js";
import { isPrivateAddress, resolveConnectTarget } from "../src/mail/address-guard.js";
import { MESSAGE_SOURCE_CAP_BYTES } from "../src/mail/constants.js";
import { createImapGateway, type ImapGateway } from "../src/mail/imap-gateway.js";
import { readMessage } from "../src/mail/operations.js";
import { IMAP_CONNECTION_TIMEOUT_MS, IMAP_SOCKET_TIMEOUT_MS } from "../src/mail/tls.js";
import { SlidingWindowRateLimit } from "../src/server/rate-limit.js";
import { createOpenMailServer, hashApiKeys } from "../src/server/index.js";
import {
  MAX_ACTIVE_KEYS_PER_USER,
  MAX_MAIL_ACCOUNTS_PER_USER,
  apiKeys,
  mailAccounts,
  users,
} from "../src/services/index.js";
import { ConfigCredentialStore, SqliteCredentialStore } from "../src/store/index.js";
import type { CredentialStore } from "../src/store/types.js";
import { parseConfig } from "../src/config/index.js";
import { readMessageInput, searchMessagesInput } from "../src/tools/schemas.js";
import { toMailError } from "../src/errors.js";
import { PERMISSIONS_POLICY } from "../src/web/headers.js";
import { RecordingSession, account, fetched, textMail } from "./fixtures.js";

const dns = (answer: string[]) => async () => answer;

describe("connect-time SSRF guard (DNS rebinding)", () => {
  it("refuses a saved hostname that now resolves to a private or metadata address", async () => {
    for (const evil of ["127.0.0.1", "10.0.0.5", "169.254.169.254", "172.18.0.2", "::1", "::ffff:7f00:1", "fd00::1", "2002:7f00:1::1"]) {
      await expect(resolveConnectTarget({ ...account, imap: { host: "rebind.example", port: 993, secure: true } }, dns([evil])))
        .rejects.toMatchObject({ code: "blocked_host" });
    }
    await expect(
      resolveConnectTarget({ ...account, imap: { host: "mixed.example", port: 993, secure: true } }, dns(["93.184.216.34", "127.0.0.1"])),
    ).rejects.toMatchObject({ code: "blocked_host" });
  });

  it("refuses private IP literals, including bracketed IPv6", async () => {
    for (const host of ["127.0.0.1", "169.254.169.254", "[::1]", "0.0.0.0"]) {
      await expect(resolveConnectTarget({ ...account, imap: { host, port: 993, secure: true } }, dns([])))
        .rejects.toMatchObject({ code: "blocked_host" });
    }
  });

  it("pins a public hostname to the checked address and keeps the name for TLS", async () => {
    const target = await resolveConnectTarget(account, dns(["93.184.216.34"]));
    expect(target).toEqual({ host: "93.184.216.34", servername: "imap.migadu.com" });
  });

  it("lets only operator-trusted hosts skip the check", async () => {
    const demo = { ...account, imap: { host: "demo-mail", port: 3143, secure: false }, insecureImapHosts: ["demo-mail"] };
    expect(await resolveConnectTarget(demo, dns(["172.20.0.3"]))).toEqual({ host: "demo-mail" });
    const local = { ...account, allowInsecureLocalhost: true, imap: { host: "127.0.0.1", port: 3143, secure: false } };
    expect(await resolveConnectTarget(local, dns([]))).toEqual({ host: "127.0.0.1" });
    // Without the allowlist entry the same private host is refused.
    await expect(resolveConnectTarget({ ...demo, insecureImapHosts: [] , imap: { host: "demo-mail", port: 993, secure: true } }, dns(["172.20.0.3"])))
      .rejects.toMatchObject({ code: "blocked_host" });
  });

  it("classifies tricky addresses", () => {
    expect(isPrivateAddress("::ffff:127.0.0.1")).toBe(true);
    expect(isPrivateAddress("::ffff:a00:1")).toBe(true);
    expect(isPrivateAddress("2001:0:4136:e378::1")).toBe(true);
    expect(isPrivateAddress("100.100.100.200")).toBe(true);
    expect(isPrivateAddress("8.8.8.8")).toBe(false);
    expect(isPrivateAddress("2a00:1450:4001:80b::200e")).toBe(false);
    expect(isPrivateAddress("not-an-ip")).toBe(true);
  });

  it("never creates an IMAP client for a rebound host, and connects to the pinned IP with verification and timeouts", async () => {
    let created: ImapFlowOptions | undefined;
    const factory = (options: ImapFlowOptions) => {
      created = options;
      return minimalClient();
    };
    const blockedGateway = createImapGateway(factory, { resolve: dns(["127.0.0.1"]) });
    await expect(blockedGateway.withClient(account, async () => "never")).rejects.toMatchObject({ code: "blocked_host" });
    expect(created).toBeUndefined();

    const gateway = createImapGateway(factory, { resolve: dns(["93.184.216.34"]) });
    await gateway.withClient(account, async () => "ok");
    expect(created?.host).toBe("93.184.216.34");
    expect(created?.servername).toBe("imap.migadu.com");
    expect(created?.tls?.rejectUnauthorized).toBe(true);
    expect(created?.connectionTimeout).toBe(IMAP_CONNECTION_TIMEOUT_MS);
    expect(created?.socketTimeout).toBe(IMAP_SOCKET_TIMEOUT_MS);
  });
});

describe("message size limits", () => {
  it("reads huge messages partially (still PEEK) and says so", async () => {
    const session = new RecordingSession();
    session.messages.set(5, fetched({
      uid: 5,
      size: MESSAGE_SOURCE_CAP_BYTES * 3,
      source: textMail({ Subject: "big", "Message-ID": "<big@example.com>" }, "start of a very large message"),
    }));
    const imap: ImapGateway = {
      withClient: async (_a, fn) => fn(session),
      withMailbox: async (_a, _f, fn) => fn(session),
    };
    const store: CredentialStore = { listAccounts: async () => [], getAccount: async () => account };
    const result = await readMessage({ store, imap }, "u", "work", "INBOX", 5);
    expect(session.fetches[0]?.source).toEqual({ maxLength: MESSAGE_SOURCE_CAP_BYTES });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.truncated).toBe(true);
    expect(result.warnings?.some((w) => w.includes("only the first part was read"))).toBe(true);
  });

  it("turns the byte cap into a BODY.PEEK partial fetch", async () => {
    let query: FetchQueryObject | undefined;
    const client = minimalClient();
    client.fetchOne = async (_uid, q) => {
      query = q;
      return false;
    };
    const gateway = createImapGateway(() => client, { resolve: dns(["93.184.216.34"]) });
    await gateway.withMailbox(account, "INBOX", (session) => session.fetchOne(1, { source: { maxLength: 1024 } }));
    expect(query?.source).toEqual({ start: 0, maxLength: 1024 });
  });

  it("bounds tool string inputs", () => {
    expect(readMessageInput.safeParse({ account: "a", folder: "x".repeat(1001), uid: 1 }).success).toBe(false);
    expect(readMessageInput.safeParse({ account: "a".repeat(201), folder: "INBOX", uid: 1 }).success).toBe(false);
    expect(readMessageInput.safeParse({ account: "a", folder: "INBOX", uid: 2 ** 33 }).success).toBe(false);
    expect(searchMessagesInput.safeParse({ account: "a", text: "y".repeat(501) }).success).toBe(false);
    expect(searchMessagesInput.safeParse({ account: "a", text: "invoice" }).success).toBe(true);
  });
});

describe("IMAP error messages", () => {
  it("does not echo host, port or syscall text", () => {
    expect(toMailError(new Error("connect ECONNREFUSED 10.0.0.5:993")).message).toBe("Could not reach the IMAP server");
    expect(toMailError(new Error("Hostname/IP does not match certificate's altnames: Host: x")).message).toBe(
      "TLS verification failed for the IMAP server",
    );
    const scrubbed = toMailError(new Error("fetch failed secret-value"), "secret-value");
    expect(scrubbed.message).toBe("IMAP request failed");
    expect(scrubbed.message).not.toContain("secret");
  });
});

describe("rate limiter memory", () => {
  it("forgets keys whose window has passed", () => {
    const limiter = new SlidingWindowRateLimit(5, 1000);
    for (let i = 0; i < 100; i += 1) limiter.allow(`k${i}`, 0);
    expect(limiter.size).toBe(100);
    limiter.allow("fresh", 5000);
    expect(limiter.size).toBe(1);
  });
});

describe("MCP bearer failures", () => {
  let server: Server | undefined;
  afterEach(async () => {
    if (!server) return;
    const s = server;
    server = undefined;
    await new Promise<void>((resolve) => s.close(() => resolve()));
  });

  it("returns 429 to a client that keeps sending bad keys, without blocking good keys", async () => {
    server = createOpenMailServer({
      store: new ConfigCredentialStore(parseConfig({ allow_insecure_localhost: false, accounts: [] })),
      imap: createImapGateway(),
      apiKeyHashes: hashApiKeys("good-key-value"),
      authFailureLimit: { limit: 2, windowMs: 60_000 },
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const port = (server.address() as AddressInfo).port;
    const post = (key: string) =>
      fetch(`http://127.0.0.1:${port}/mcp`, {
        method: "POST",
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: "{}",
      });
    expect((await post("bad-1")).status).toBe(401);
    expect((await post("bad-2")).status).toBe(401);
    const limited = await post("bad-3");
    expect(limited.status).toBe(429);
    expect(limited.headers.get("permissions-policy")).toBe(PERMISSIONS_POLICY);
    expect(limited.headers.get("cross-origin-opener-policy")).toBe("same-origin");
    expect((await post("good-key-value")).status).not.toBe(401);
  });
});

describe("per-user caps, deletion and crypto", () => {
  async function setup() {
    const db = openDatabase(":memory:");
    migrate(db);
    const masterKey = loadMasterKey(generateTestMasterKey());
    const user = await users.create(db, masterKey, { email: "cap@example.com", password: "cap-password-1" });
    return { db, masterKey, user };
  }

  it("caps active API keys and mail accounts per user", async () => {
    const { db, masterKey, user } = await setup();
    const keys = [];
    for (let i = 0; i < MAX_ACTIVE_KEYS_PER_USER; i += 1) keys.push(apiKeys.create(db, { userId: user.id, name: `k${i}` }));
    expect(() => apiKeys.create(db, { userId: user.id, name: "one too many" })).toThrow(/up to/);
    apiKeys.revoke(db, user.id, keys[0]!.id);
    expect(apiKeys.create(db, { userId: user.id, name: "after revoke" }).token).toMatch(/^om_/);

    for (let i = 0; i < MAX_MAIL_ACCOUNTS_PER_USER; i += 1) {
      mailAccounts.add(db, masterKey, { userId: user.id, name: `m${i}`, email: `m${i}@example.com`, preset: "migadu", password: "x" });
    }
    expect(() =>
      mailAccounts.add(db, masterKey, { userId: user.id, name: "extra", email: "e@example.com", preset: "migadu", password: "x" }),
    ).toThrow(/up to/);
    db.close();
  });

  it("delete-user needs --yes, then removes keys, sessions and mailboxes so the key stops working", async () => {
    const { db, masterKey, user } = await setup();
    const key = apiKeys.create(db, { userId: user.id, name: "k" });
    const added = mailAccounts.add(db, masterKey, { userId: user.id, name: "m", email: "m@example.com", preset: "migadu", password: "pw" });
    const lines: string[] = [];
    const io = { readSecret: async () => "", env: {}, out: (l: string) => lines.push(l) };
    const deps = { db, masterKey, imap: createImapGateway() };
    await expect(runAdmin(["delete-user", "--email", "cap@example.com"], deps, io)).rejects.toThrow(/--yes/);
    expect(apiKeys.resolve(db, key.token)).not.toBeNull();
    await runAdmin(["delete-user", "--email", "cap@example.com", "--yes"], deps, io);
    expect(lines.at(-1)).toMatch(/deleted user cap@example.com .*accounts=1 keys=1/);
    expect(apiKeys.resolve(db, key.token)).toBeNull();
    expect(await new SqliteCredentialStore(db, masterKey).getAccount(user.id, added.id)).toBeNull();
    expect(db.prepare("SELECT COUNT(*) AS n FROM users").get()).toEqual({ n: 0 });
    db.close();
  });

  it("rejects a truncated GCM tag", () => {
    const key = Buffer.alloc(32, 7);
    const sealed = sealPassword(key, "acct", "secret");
    expect(() => openPassword(key, "acct", { ...sealed, tag: sealed.tag.subarray(0, 4) })).toThrow("Decryption failed");
    expect(() => openPassword(key, "other-acct", sealed)).toThrow("Decryption failed");
  });
});

type FakeClient = ReturnType<NonNullable<Parameters<typeof createImapGateway>[0]>>;

function minimalClient(): FakeClient {
  const client = {
    capabilities: new Map<string, boolean | number>(),
    async connect() {},
    async logout() {},
    close() {},
    async list() {
      return [];
    },
    async status() {
      return false as const;
    },
    async getMailboxLock() {
      return { path: "INBOX", release() {} };
    },
    async search() {
      return [];
    },
    fetchOne: async (_uid: number, _q: FetchQueryObject): Promise<unknown> => false,
    async fetchAll() {
      return [];
    },
  };
  return client as unknown as FakeClient;
}
