import { afterEach, describe, expect, it } from "vitest";
import { invoicePdf } from "../src/demo/messages.js";
import { createImapGateway, DEFAULT_MAX_LITERAL_BYTES } from "../src/mail/imap-gateway.js";
import { getAttachment } from "../src/mail/get-attachment.js";
import { readMessage } from "../src/mail/operations.js";
import type { AccountCredentials, CredentialStore } from "../src/store/types.js";
import { account } from "./fixtures.js";
import { startFakeImapServer, type FakeImapServer, type FetchHandler } from "./helpers/fake-imap-server.js";

/**
 * Transport-level tests: the real imapflow client against a loopback fake
 * server, so receive limits and imapflow's own BODYSTRUCTURE parsing are
 * exercised, not a fake client.
 */
const LIMITS = { maxBytes: 64 * 1024, base64MaxBytes: 64 * 1024, pdfMaxPages: 5, pdfTimeoutMs: 10_000 };

const ENVELOPE = '("Mon, 2 Nov 2026 10:00:00 +0000" "Fwd" NIL NIL NIL NIL NIL NIL NIL "<inner@example.com>")';
const TEXT_PART = '("TEXT" "PLAIN" ("CHARSET" "utf-8") NIL NIL "7BIT" 5 1 NIL NIL NIL NIL)';
const pdfPart = (size: number) => `("APPLICATION" "PDF" ("NAME" "a.pdf") NIL NIL "BASE64" ${size} NIL ("ATTACHMENT" ("FILENAME" "a.pdf")) NIL NIL)`;
/** text body, then a base64 PDF attachment declared at 100 bytes. */
const MIXED = `(${TEXT_PART}${pdfPart(100)} "MIXED" ("BOUNDARY" "b") NIL NIL NIL)`;

let server: FakeImapServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

function deps(port: number) {
  const credentials: AccountCredentials = { ...account, allowInsecureLocalhost: true, imap: { host: "127.0.0.1", port, secure: false } };
  const store: CredentialStore = {
    async listAccounts() { return []; },
    async getAccount() { return credentials; },
  };
  return { store, imap: createImapGateway(undefined, { timeoutMs: 5_000, graceMs: 1_000 }), attachmentLimits: LIMITS };
}

/** Serves `structure` for the BODYSTRUCTURE fetch and `parts[section]` for part fetches; records the sections asked for. */
function serve(structure: string, parts: Record<string, Buffer>, sections: string[] = []): FetchHandler {
  return (command, socket, done) => {
    if (/BODYSTRUCTURE/i.test(command)) {
      socket.write(`* 1 FETCH (UID 9 RFC822.SIZE 4000 BODYSTRUCTURE ${structure})\r\n`);
      done();
      return;
    }
    const section = /BODY\.PEEK\[([^\]]*)\]/i.exec(command)?.[1] ?? "";
    sections.push(section);
    const body = parts[section];
    if (body) {
      socket.write(`* 1 FETCH (UID 9 BODY[${section}]<0> {${body.length}}\r\n`);
      socket.write(body);
      socket.write(")\r\n");
    }
    done();
  };
}

/** Answers the BODYSTRUCTURE fetch, then announces a literal of `announced` bytes for the part and sends 64 KB of it. */
function oversizedPart(announced: number): FetchHandler {
  return (command, socket, done) => {
    if (/BODYSTRUCTURE/i.test(command)) {
      socket.write(`* 1 FETCH (UID 9 RFC822.SIZE 400 BODYSTRUCTURE ${MIXED})\r\n`);
      done();
      return;
    }
    const section = /BODY\.PEEK\[([^\]]*)\]/i.exec(command)?.[1] ?? "";
    socket.write(`* 1 FETCH (UID 9 BODY[${section}]<0> {${announced}}\r\n`);
    socket.write(Buffer.alloc(64 * 1024, 0x41));
    // Never finishes the literal; the client must give up on the announced size alone.
  };
}

describe("IMAP receive limits", () => {
  it("rejects an attachment literal over the wire cap before buffering it, closes the connection, and reports too_large", async () => {
    // 1 MB is under the default connection cap, so only the per-call attachment cap can stop it.
    server = await startFakeImapServer(oversizedPart(1024 * 1024));
    const started = Date.now();
    const result = await getAttachment(deps(server.port), "user-1", "work", "INBOX", 9, { index: 0 });
    expect(result).toMatchObject({ ok: false, error: { code: "too_large" } });
    await server.closed;
    expect(Date.now() - started).toBeLessThan(4_000);
    expect(server.commands.some((command) => /BODY\.PEEK\[2\]<0\.\d+>/.test(command))).toBe(true);
  });

  it("applies the default literal cap to other reads too", async () => {
    server = await startFakeImapServer((_command, socket) => {
      // A server that ignores BODY.PEEK[]<0.n> and announces a 2 GB message.
      socket.write(`* 1 FETCH (UID 9 FLAGS () BODY[] {${2 * 1024 * 1024 * 1024}}\r\n`);
      socket.write(Buffer.alloc(1024, 0x41));
    });
    const result = await readMessage(deps(server.port), "user-1", "work", "INBOX", 9);
    expect(result).toMatchObject({ ok: false, error: { code: "too_large" } });
    await server.closed;
    expect(DEFAULT_MAX_LITERAL_BYTES).toBeLessThan(16 * 1024 * 1024);
  });

  it("still downloads a part within the cap", async () => {
    server = await startFakeImapServer(serve(MIXED, { "2": Buffer.from(invoicePdf().toString("base64")) }));
    const result = await getAttachment(deps(server.port), "user-1", "work", "INBOX", 9, { index: 0 });
    expect(result).toMatchObject({ ok: true, data: { part: "2", kind: "pdf", pages: 1 } });
  });
});

describe("imapflow-shaped BODYSTRUCTURE", () => {
  it("lists and fetches an attached email that is the whole message (root message/rfc822) as part 1 via TEXT", async () => {
    const structure = `("MESSAGE" "RFC822" NIL NIL NIL "7BIT" 120 ${ENVELOPE} ${TEXT_PART} 5 NIL ("ATTACHMENT" ("FILENAME" "fwd.eml")) NIL NIL)`;
    const sections: string[] = [];
    const inner = Buffer.from("Subject: Inner\r\nFrom: a@example.com\r\nContent-Type: text/plain\r\n\r\nInner body\r\n");
    server = await startFakeImapServer(serve(structure, { TEXT: inner }, sections));
    const result = await getAttachment(deps(server.port), "user-1", "work", "INBOX", 9, { index: 0 });
    expect(result).toMatchObject({ ok: true, data: { index: 0, part: "1", filename: "fwd.eml", kind: "email" } });
    expect(result.ok && result.data.text).toContain("Inner body");
    expect(sections).toEqual(["TEXT"]);
  });

  it("numbers parts inside an inline top-level message/rfc822 as 1.n, not as top-level parts", async () => {
    // imapflow labels the inner parts "1" and "2"; IMAP numbers them 1.1 and 1.2.
    const innerMixed = `(${TEXT_PART}${pdfPart(100)} "MIXED" ("BOUNDARY" "c") NIL NIL NIL)`;
    const structure = `("MESSAGE" "RFC822" NIL NIL NIL "7BIT" 400 ${ENVELOPE} ${innerMixed} 12 NIL NIL NIL NIL)`;
    const sections: string[] = [];
    server = await startFakeImapServer(serve(structure, { "1.2": Buffer.from(invoicePdf().toString("base64")) }, sections));
    const result = await getAttachment(deps(server.port), "user-1", "work", "INBOX", 9, { index: 0 });
    expect(result).toMatchObject({ ok: true, data: { index: 0, part: "1.2", filename: "a.pdf", kind: "pdf" } });
    expect(sections).toEqual(["1.2"]);
  });

  it("fetches the body of a single-part message inside an inline message/rfc822 as N.1", async () => {
    // imapflow gives the inner PDF the wrapper's number "2"; BODY[2] would be the whole inner message.
    const structure = `(${TEXT_PART}("MESSAGE" "RFC822" NIL NIL NIL "7BIT" 400 ${ENVELOPE} ${pdfPart(100)} 12 NIL NIL NIL NIL) "MIXED" ("BOUNDARY" "b") NIL NIL NIL)`;
    const sections: string[] = [];
    server = await startFakeImapServer(serve(structure, { "2.1": Buffer.from(invoicePdf().toString("base64")) }, sections));
    const result = await getAttachment(deps(server.port), "user-1", "work", "INBOX", 9, { index: 0 });
    expect(result).toMatchObject({ ok: true, data: { index: 0, part: "2.1", kind: "pdf" } });
    expect(sections).toEqual(["2.1"]);
  });
});
