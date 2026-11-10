import { describe, expect, it } from "vitest";
import { attachmentLimitsFromEnv, type AttachmentLimits } from "../src/config/runtime.js";
import { invoicePdf } from "../src/demo/messages.js";
import { ATTACHMENT_CHAR_CAP, UNTRUSTED_CONTENT_WARNING } from "../src/mail/constants.js";
import { decodeCharset, decodeTransfer } from "../src/mail/decode.js";
import { classify, getAttachment, type AttachmentRequest } from "../src/mail/get-attachment.js";
import type { ImapGateway } from "../src/mail/imap-gateway.js";
import { readMessage } from "../src/mail/operations.js";
import { findPart, listAttachmentParts, listAttachments, type BodyNode } from "../src/mail/structure.js";
import type { CredentialStore } from "../src/store/types.js";
import { RecordingSession, account, fetched } from "./fixtures.js";

const LIMITS: AttachmentLimits = { maxBytes: 1024 * 1024, pdfMaxPages: 100, pdfTimeoutMs: 10_000 };

function harness(limits: AttachmentLimits = LIMITS) {
  const session = new RecordingSession();
  const imap: ImapGateway = {
    async withClient(_account, fn) { return fn(session); },
    async withMailbox(_account, _folder, fn) { return fn(session); },
    async appendMessage() { throw new Error("must not append"); },
  };
  const store: CredentialStore = {
    async listAccounts() { return []; },
    async getAccount(_user, id) { return id === account.id ? account : null; },
  };
  const deps = { store, imap, attachmentLimits: limits };
  const get = (request: AttachmentRequest, uid = 7) => getAttachment(deps, "user-1", "work", "INBOX", uid, request);
  return { session, deps, get };
}

/** multipart/mixed: 1 text body, then the given attachment parts as 2, 3, ... */
function mixed(...parts: BodyNode[]): BodyNode {
  return {
    type: "multipart/mixed",
    childNodes: [{ type: "text/plain", part: "1", parameters: { charset: "utf-8" }, size: 10 }, ...parts.map((p, i) => ({ ...p, part: p.part ?? String(i + 2) }))],
  };
}

function attachment(type: string, filename: string, extra: Partial<BodyNode> = {}): BodyNode {
  return { type, disposition: "attachment", dispositionParameters: { filename }, encoding: "base64", ...extra };
}

function base64Lines(bytes: Buffer): Buffer {
  return Buffer.from(bytes.toString("base64").replace(/.{76}/g, "$&\r\n"));
}

function seed(session: RecordingSession, root: BodyNode, parts: Record<string, Buffer>, uid = 7) {
  session.messages.set(uid, fetched({ uid, bodyStructure: root, flags: [] }));
  for (const [section, raw] of Object.entries(parts)) session.parts.set(`${uid}:${section}`, raw);
}

/** A tiny valid PDF with one line of text per page. */
function simplePdf(pages: string[]): Buffer {
  const objects = ["<< /Type /Catalog /Pages 2 0 R >>", ""];
  const kids: string[] = [];
  for (const line of pages) {
    const pageObj = objects.length + 1;
    const content = `BT /F1 12 Tf 56 760 Td (${line}) Tj ET`;
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${pageObj + 1} 0 R /Resources << /Font << /F1 FONT 0 R >> >> >>`);
    objects.push(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
    kids.push(`${pageObj} 0 R`);
  }
  const font = objects.length + 1;
  objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  objects[1] = `<< /Type /Pages /Kids [${kids.join(" ")}] /Count ${pages.length} >>`;
  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${i + 1} 0 obj\n${body.replace("FONT", String(font))}\nendobj\n`;
  });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, "latin1");
}

describe("attachment structure", () => {
  it("lists attachments in BODYSTRUCTURE order with part numbers and finds parts", () => {
    const root: BodyNode = {
      type: "multipart/mixed",
      childNodes: [
        { type: "multipart/alternative", part: "1", childNodes: [{ type: "text/plain", part: "1.1" }, { type: "text/html", part: "1.2" }] },
        attachment("application/pdf", "a.pdf", { part: "2" }),
        { type: "image/png", part: "3", id: "<logo@x>", disposition: "inline" },
        { type: "message/rfc822", part: "4", disposition: "attachment", dispositionParameters: { filename: "fwd.eml" }, childNodes: [{ type: "text/plain", part: "4.1" }] },
      ],
    };
    expect(listAttachmentParts(root).map((a) => [a.index, a.part, a.filename, a.content_type, a.content_id])).toEqual([
      [0, "2", "a.pdf", "application/pdf", null],
      [1, "3", null, "image/png", "logo@x"],
      [2, "4", "fwd.eml", "message/rfc822", null],
    ]);
    expect(findPart(root, "1.2")?.type).toBe("text/html");
    expect(findPart(root, "1")).toBeNull();
    expect(findPart(root, "9")).toBeNull();
    const single: BodyNode = { type: "application/pdf", disposition: "attachment", parameters: { name: "only.pdf" } };
    expect(listAttachmentParts(single).map((a) => a.part)).toEqual(["1"]);
    expect(listAttachmentParts({ type: "text/plain" })).toEqual([]);
  });

  it("merges parsed attachments with BODYSTRUCTURE so read_message shows index and part", () => {
    const root = mixed(attachment("application/pdf", "a.pdf", { size: 780 }), attachment("image/png", "b.png", { size: 78 }));
    const listed = listAttachments([
      { filename: "a.pdf", content_type: "application/pdf", size: 500, content_id: null },
      { filename: "ghost.bin", content_type: "application/zip", size: 9, content_id: null },
    ], root);
    expect(listed).toEqual([
      { index: 0, part: "2", filename: "a.pdf", content_type: "application/pdf", size: 500, content_id: null },
      { index: 1, part: "3", filename: "b.png", content_type: "image/png", size: 57, content_id: null },
      { index: null, part: null, filename: "ghost.bin", content_type: "application/zip", size: 9, content_id: null },
    ]);
  });

  it("read_message lists index and part for each attachment", async () => {
    const { session, deps } = harness();
    const raw = Buffer.from([
      "Subject: s", "MIME-Version: 1.0", 'Content-Type: multipart/mixed; boundary="b"', "", "--b",
      "Content-Type: text/plain", "", "hi", "--b", "Content-Type: application/pdf",
      'Content-Disposition: attachment; filename="invoice.pdf"', "Content-Transfer-Encoding: base64", "",
      invoicePdf().toString("base64"), "--b--", "",
    ].join("\r\n"));
    session.messages.set(7, fetched({ uid: 7, source: raw, bodyStructure: mixed(attachment("application/pdf", "invoice.pdf")) }));
    const result = await readMessage(deps, "user-1", "work", "INBOX", 7);
    expect(result.ok && result.data.attachments).toEqual([
      { index: 0, part: "2", filename: "invoice.pdf", content_type: "application/pdf", size: invoicePdf().length, content_id: null },
    ]);
  });
});

describe("part decoding", () => {
  it("decodes base64, quoted-printable and charsets", () => {
    expect(decodeTransfer(Buffer.from("aGVs\r\nbG8=\r\n"), "base64").toString()).toBe("hello");
    expect(decodeTransfer(Buffer.from("caf=C3=A9 =\r\nau lait=3D=\nok =ZZ"), "quoted-printable").toString()).toBe("café au lait=ok =ZZ");
    expect(decodeTransfer(Buffer.from("plain"), "7bit").toString()).toBe("plain");
    expect(decodeCharset(Buffer.from([0x63, 0x61, 0x66, 0xe9]), "ISO-8859-1")).toMatchObject({ text: "café", unknownCharset: false });
    expect(decodeCharset(Buffer.from([0x80]), "windows-1252").text).toBe("€");
    expect(decodeCharset(Buffer.from("snow ☃"), undefined)).toMatchObject({ text: "snow ☃", charset: "utf-8" });
    expect(decodeCharset(Buffer.from("x"), "x-made-up")).toMatchObject({ text: "x", unknownCharset: true });
  });

  it("classifies by type, falling back to the file name for generic types", () => {
    expect(classify({ type: "application/pdf" }, null)).toBe("pdf");
    expect(classify({ type: "application/octet-stream" }, "scan.PDF")).toBe("pdf");
    expect(classify({ type: "text/csv" }, null)).toBe("text");
    expect(classify({ type: "application/json" }, null)).toBe("text");
    expect(classify({ type: "application/vnd.api+json" }, null)).toBe("text");
    expect(classify({ type: "application/xml" }, null)).toBe("text");
    expect(classify({ type: "application/octet-stream" }, "data.csv")).toBe("text");
    expect(classify({ type: "message/rfc822" }, null)).toBe("email");
    expect(classify({ type: "image/png" }, "a.pdf")).toBe("binary");
    expect(classify({ type: "application/zip" }, "a.zip")).toBe("binary");
  });

  it("reads attachment limits from the environment", () => {
    expect(attachmentLimitsFromEnv({})).toEqual({ maxBytes: 10 * 1024 * 1024, pdfMaxPages: 100, pdfTimeoutMs: 10_000 });
    expect(attachmentLimitsFromEnv({ OPENMAIL_ATTACHMENT_MAX_BYTES: "2097152", OPENMAIL_PDF_MAX_PAGES: "5", OPENMAIL_PDF_TIMEOUT_MS: "3000" }))
      .toEqual({ maxBytes: 2_097_152, pdfMaxPages: 5, pdfTimeoutMs: 3_000 });
    expect(() => attachmentLimitsFromEnv({ OPENMAIL_ATTACHMENT_MAX_BYTES: "1" })).toThrow(/OPENMAIL_ATTACHMENT_MAX_BYTES/);
    expect(() => attachmentLimitsFromEnv({ OPENMAIL_PDF_MAX_PAGES: "x" })).toThrow(/OPENMAIL_PDF_MAX_PAGES/);
  });
});

describe("get_attachment", () => {
  it("fetches only the requested part with BODYSTRUCTURE, never the message source", async () => {
    const { session, get } = harness();
    seed(session, mixed(attachment("text/plain", "notes.txt", { encoding: "quoted-printable", parameters: { charset: "iso-8859-1" }, size: 20 })),
      { "2": Buffer.from("caf=E9 cr=E8me\r\n") });
    const result = await get({ index: 0 });
    expect(result).toMatchObject({
      ok: true,
      truncated: false,
      data: { uid: 7, folder: "INBOX", index: 0, part: "2", filename: "notes.txt", content_type: "text/plain", kind: "text",
        charset: "windows-1252", text: "café crème\r\n", text_length: 12, base64: null, size: 12 },
    });
    expect(result.warnings).toContain(UNTRUSTED_CONTENT_WARNING);
    expect(session.fetches).toEqual([{ bodyStructure: true, size: true }]);
    expect(session.partFetches).toEqual([{ uid: 7, section: "2", maxBytes: LIMITS.maxBytes * 3 + 1 }]);
  });

  it("converts HTML like message bodies and caps long text with the total length", async () => {
    const { session, get } = harness();
    const csv = `a,b\n${"1,2\n".repeat(10_000)}`;
    seed(session, mixed(
      attachment("text/html", "page.html", { encoding: "7bit" }),
      attachment("text/csv", "data.csv"),
      attachment("application/json", "data.json", { encoding: "8bit" }),
    ), {
      "2": Buffer.from("<html><body><p>Hello <b>bold</b></p><script>ignore-me</script></body></html>"),
      "3": base64Lines(Buffer.from(csv)),
      "4": Buffer.from('{"total": 14.4}'),
    });
    const html = await get({ part: "2" });
    expect(html.ok && html.data.text).toBe("Hello bold");
    const big = await get({ index: 1 });
    expect(big).toMatchObject({ ok: true, truncated: true, data: { kind: "text", text_length: csv.length } });
    expect(big.ok && big.data.text?.length).toBe(ATTACHMENT_CHAR_CAP);
    expect(big.warnings.some((w) => w.includes(`${ATTACHMENT_CHAR_CAP} characters of ${csv.length}`))).toBe(true);
    const json = await get({ index: 2, part: "4" });
    expect(json.ok && json.data.text).toBe('{"total": 14.4}');
  });

  it("returns PDF text and page count", async () => {
    const { session, get } = harness();
    seed(session, mixed(attachment("application/pdf", "invoice-NW-2026-1042.pdf")), { "2": base64Lines(invoicePdf()) });
    const result = await get({ index: 0 });
    expect(result).toMatchObject({ ok: true, truncated: false, data: { kind: "pdf", pages: 1, pages_read: 1, size: invoicePdf().length, base64: null } });
    expect(result.ok && result.data.text).toContain("Total due ....................... USD 14.40");
    expect(result.warnings).toContain(UNTRUSTED_CONTENT_WARNING);
  });

  it("limits PDF pages, and fails cleanly on broken PDFs and slow parses", async () => {
    const { session, get } = harness({ ...LIMITS, pdfMaxPages: 2 });
    seed(session, mixed(
      attachment("application/pdf", "three.pdf"),
      attachment("application/pdf", "broken.pdf"),
      attachment("application/octet-stream", "fake.pdf"),
    ), {
      "2": base64Lines(simplePdf(["page one", "page two", "page three"])),
      "3": base64Lines(Buffer.from("%PDF-1.7\n1 0 obj << /Type /Catalog >>\ngarbage")),
      "4": base64Lines(Buffer.from("MZ not a pdf at all")),
    });
    const limited = await get({ index: 0 });
    expect(limited).toMatchObject({ ok: true, truncated: true, data: { pages: 3, pages_read: 2 } });
    expect(limited.ok && limited.data.text).toBe("page one\n\npage two");
    expect(limited.warnings).toContain("Only the first 2 of 3 PDF pages were read.");
    for (const index of [1, 2]) {
      const broken = await get({ index });
      expect(broken).toMatchObject({ ok: false, error: { code: "parse_error" } });
    }
    const slow = harness({ ...LIMITS, pdfTimeoutMs: 1 });
    seed(slow.session, mixed(attachment("application/pdf", "a.pdf")), { "2": base64Lines(invoicePdf()) });
    const timedOut = await slow.get({ index: 0 });
    expect(timedOut).toMatchObject({ ok: false, error: { code: "parse_error", message: expect.stringContaining("took longer") } });
  });

  it("returns metadata for other files, and base64 only on request within the cap", async () => {
    const { session, get } = harness();
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
    seed(session, mixed(attachment("image/png", "logo.png", { size: 12, id: "<logo@x>" })), { "2": base64Lines(png) });
    const meta = await get({ index: 0 });
    expect(meta).toMatchObject({ ok: true, data: { kind: "binary", text: null, base64: null, content_id: "logo@x", message: expect.stringContaining("include_base64=true") } });
    expect(session.partFetches).toEqual([]);
    const full = await get({ index: 0, include_base64: true });
    expect(full.ok && full.data.base64).toBe(png.toString("base64"));
    expect(full.ok && full.data.size).toBe(png.length);
  });

  it("does not download a part over the cap, and aborts when the server sends more than the cap", async () => {
    const { session, get } = harness({ ...LIMITS, maxBytes: 64 * 1024 });
    seed(session, mixed(
      attachment("application/pdf", "huge.pdf", { size: 10 * 1024 * 1024 }),
      attachment("application/zip", "huge.zip", { size: 10 * 1024 * 1024 }),
      attachment("text/plain", "liar.txt", { size: 10, encoding: "7bit" }),
    ), { "4": Buffer.alloc(200 * 1024, 0x61) });
    const pdf = await get({ index: 0 });
    expect(pdf).toMatchObject({ ok: true, data: { text: null, base64: null, message: expect.stringContaining("over the 64 KB limit") } });
    const zip = await get({ index: 1, include_base64: true });
    expect(zip).toMatchObject({ ok: true, data: { base64: null, message: expect.stringContaining("not downloaded") } });
    expect(session.partFetches).toEqual([]);
    const liar = await get({ index: 2 });
    expect(liar).toMatchObject({ ok: false, error: { code: "too_large" } });
    expect(session.partFetches).toEqual([{ uid: 7, section: "4", maxBytes: 64 * 1024 + 1 }]);
  });

  it("reads a single-part message as TEXT and an attached email as text", async () => {
    const { session, get } = harness();
    seed(session, { type: "application/pdf", disposition: "attachment", parameters: { name: "only.pdf" }, encoding: "base64" }, { TEXT: base64Lines(invoicePdf()) });
    const single = await get({ part: "1" });
    expect(single).toMatchObject({ ok: true, data: { part: "1", index: 0, kind: "pdf", pages: 1 } });
    expect(session.partFetches.at(-1)?.section).toBe("TEXT");

    const email = Buffer.from("Subject: Forwarded\r\nFrom: Priya <priya@example.com>\r\nContent-Type: text/plain\r\n\r\nInner body\r\n");
    seed(session, mixed({ type: "message/rfc822", disposition: "attachment", dispositionParameters: { filename: "fwd.eml" }, encoding: "7bit" }), { "2": email }, 8);
    const inner = await get({ index: 0 }, 8);
    expect(inner).toMatchObject({ ok: true, data: { kind: "email" } });
    expect(inner.ok && inner.data.text).toContain("Subject: Forwarded\nFrom: priya@example.com");
    expect(inner.ok && inner.data.text).toContain("Inner body");
  });

  it("reports clear errors for bad selectors and missing messages or parts", async () => {
    const { session, get } = harness();
    seed(session, mixed(attachment("application/pdf", "a.pdf")), {});
    expect(await get({})).toMatchObject({ ok: false, error: { code: "invalid_argument", message: expect.stringContaining("index or part") } });
    expect(await get({ part: "2;DROP" })).toMatchObject({ ok: false, error: { code: "invalid_argument" } });
    expect(await get({ index: -1 })).toMatchObject({ ok: false, error: { code: "invalid_argument" } });
    expect(await get({ index: 0, part: "3" })).toMatchObject({ ok: false, error: { code: "invalid_argument", message: expect.stringContaining("part 2") } });
    expect(await get({ index: 5 })).toMatchObject({ ok: false, error: { code: "not_found", message: expect.stringContaining("1 attachment") } });
    expect(await get({ part: "9" })).toMatchObject({ ok: false, error: { code: "not_found" } });
    expect(await get({ index: 0 }, 99)).toMatchObject({ ok: false, error: { code: "not_found" } });
    expect(await get({ index: 0 })).toMatchObject({ ok: false, error: { code: "not_found", message: expect.stringContaining("could not be fetched") } });
    const body = await get({ part: "1" });
    expect(body).toMatchObject({ ok: false, error: { code: "not_found" } });
  });
});
