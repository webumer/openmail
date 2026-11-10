/** Decoding for one body part fetched raw from IMAP (BODY.PEEK[part]). */

/** Undo Content-Transfer-Encoding. 7bit, 8bit, binary and unknown encodings pass through. */
export function decodeTransfer(raw: Buffer, encoding: string | null | undefined): Buffer {
  switch ((encoding ?? "").trim().toLowerCase()) {
    case "base64":
      // Buffer ignores line breaks and stops at the first invalid character.
      return Buffer.from(raw.toString("latin1").replace(/[^A-Za-z0-9+/=]/g, ""), "base64");
    case "quoted-printable":
      return decodeQuotedPrintable(raw);
    default:
      return raw;
  }
}

function decodeQuotedPrintable(raw: Buffer): Buffer {
  const out = Buffer.alloc(raw.length);
  let length = 0;
  for (let i = 0; i < raw.length; i += 1) {
    const byte = raw[i]!;
    if (byte !== 0x3d) {
      out[length++] = byte;
      continue;
    }
    // Soft line break: "=" followed by optional whitespace and CRLF or LF.
    let j = i + 1;
    while (j < raw.length && (raw[j] === 0x20 || raw[j] === 0x09)) j += 1;
    if (raw[j] === 0x0d && raw[j + 1] === 0x0a) {
      i = j + 1;
      continue;
    }
    if (raw[j] === 0x0a) {
      i = j;
      continue;
    }
    const hex = raw.toString("latin1", i + 1, i + 3);
    if (/^[0-9A-Fa-f]{2}$/.test(hex)) {
      out[length++] = Number.parseInt(hex, 16);
      i += 2;
    } else {
      out[length++] = byte;
    }
  }
  return out.subarray(0, length);
}

/**
 * Decode text in the part's declared charset. A missing charset is read as
 * UTF-8 (a superset of the RFC 2046 US-ASCII default); an unknown one falls
 * back to UTF-8 and is reported, so the caller can warn.
 */
export function decodeCharset(bytes: Buffer, charset: string | null | undefined): { text: string; charset: string; unknownCharset: boolean } {
  const label = (charset ?? "").trim().replace(/^["']|["']$/g, "").toLowerCase() || "utf-8";
  try {
    const decoder = new TextDecoder(label, { fatal: false });
    return { text: decoder.decode(bytes), charset: decoder.encoding, unknownCharset: false };
  } catch {
    return { text: new TextDecoder("utf-8").decode(bytes), charset: "utf-8", unknownCharset: true };
  }
}
