import { describe, expect, it } from "vitest";
import { parseMessage } from "../src/mail/parse-message.js";

describe("parseMessage", () => {
  it("strips an HTML-only body and keeps the original offset", async () => {
    const parsed = await parseMessage(htmlOnly());
    expect(parsed.text).toContain("Hello");
    expect(parsed.text).toContain("world");
    expect(parsed.text).not.toContain("<b>");
    expect(parsed.text).not.toContain("ignore-this-token");
    expect(parsed.headers.subject).toBe("Hello");
    expect(parsed.headers.from).toEqual([{ name: "Ada Lovelace", address: "ada@example.com" }]);
    expect(parsed.headers.to).toEqual([{ name: "Bo", address: "bo@example.com" }]);
    expect(parsed.headers.cc).toEqual([{ name: null, address: "cy@example.com" }]);
    expect(parsed.headers.reply_to).toEqual([{ name: null, address: "replies@example.com" }]);
    expect(parsed.headers.message_id).toBe("<root@example.com>");
    expect(parsed.headers.in_reply_to).toBe("<parent@example.com>");
    expect(parsed.headers.references).toEqual(["<parent@example.com>"]);
    expect(parsed.headers.date).toEqual({
      utc: "2026-10-21T13:19:00.000Z",
      original_offset: "+05:00",
      original: "Wed, 21 Oct 2026 18:19:00 +0500",
    });
    expect(parsed.attachments).toEqual([]);
  });

  it("prefers text/plain and lists attachment metadata without bytes", async () => {
    const parsed = await parseMessage(mixed());
    expect(parsed.text).toContain("plain body");
    expect(parsed.text).not.toContain("html body");
    expect(parsed.attachments).toHaveLength(1);
    const attachment = parsed.attachments[0];
    expect(attachment).toMatchObject({
      filename: "note.pdf",
      content_type: "application/pdf",
      content_id: "file@example.com",
    });
    expect(attachment?.size).toBeGreaterThan(0);
    expect(Object.keys(attachment ?? {}).sort()).toEqual(["content_id", "content_type", "filename", "size"]);
    expect(JSON.stringify(parsed)).not.toContain("ATTACHMENT-BYTES-TOKEN");
  });
});

function htmlOnly(): string {
  return [
    "From: Ada Lovelace <ada@example.com>",
    "To: Bo <bo@example.com>",
    "Cc: cy@example.com",
    "Reply-To: replies@example.com",
    "Subject: Hello",
    "Date: Wed, 21 Oct 2026 18:19:00 +0500",
    "Message-ID: <root@example.com>",
    "In-Reply-To: <parent@example.com>",
    "References: <parent@example.com>",
    "MIME-Version: 1.0",
    "Content-Type: text/html; charset=utf-8",
    "",
    "<p>Hello <b>world</b></p><script>ignore-this-token</script>",
  ].join("\r\n");
}

function mixed(): string {
  const bytes = Buffer.from("ATTACHMENT-BYTES-TOKEN").toString("base64");
  return [
    "From: Ada <ada@example.com>",
    "To: Bo <bo@example.com>",
    "Subject: Files",
    "Date: Wed, 21 Oct 2026 18:19:00 +0000",
    "Message-ID: <files@example.com>",
    "MIME-Version: 1.0",
    'Content-Type: multipart/mixed; boundary="bound"',
    "",
    "--bound",
    "Content-Type: multipart/alternative; boundary=\"alt\"",
    "",
    "--alt",
    "Content-Type: text/plain; charset=utf-8",
    "",
    "plain body",
    "--alt",
    "Content-Type: text/html; charset=utf-8",
    "",
    "<p>html body</p>",
    "--alt--",
    "--bound",
    'Content-Type: application/pdf; name="note.pdf"',
    'Content-Disposition: attachment; filename="note.pdf"',
    "Content-Transfer-Encoding: base64",
    "Content-ID: <file@example.com>",
    "",
    bytes,
    "--bound--",
    "",
  ].join("\r\n");
}
