import { MailError } from "../errors.js";

/** Opaque search cursor: base64 JSON of an offset and a newest-first UID boundary. */
export interface CursorPayload {
  v: 1;
  offset: number;
  /** Last UID already returned. Resume with UIDs strictly below this. Null uses `offset` instead. */
  uid: number | null;
}

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

export function encodeCursor(payload: CursorPayload): string {
  validatePayload(payload);
  return Buffer.from(JSON.stringify({ v: 1, offset: payload.offset, uid: payload.uid }), "utf8").toString("base64");
}

export function decodeCursor(cursor: string): CursorPayload {
  if (typeof cursor !== "string" || cursor.length === 0 || cursor.length % 4 !== 0 || !BASE64.test(cursor)) {
    throw new MailError("invalid_cursor", "Cursor is not valid base64");
  }
  let json: unknown;
  try {
    json = JSON.parse(Buffer.from(cursor, "base64").toString("utf8"));
  } catch {
    throw new MailError("invalid_cursor", "Cursor is not valid JSON");
  }
  if (!json || typeof json !== "object" || Array.isArray(json)) {
    throw new MailError("invalid_cursor", "Cursor payload is not an object");
  }
  const record = json as Record<string, unknown>;
  if (record.v !== 1) throw new MailError("invalid_cursor", "Unsupported cursor version");
  if (typeof record.offset !== "number" || !Number.isSafeInteger(record.offset) || record.offset < 0) {
    throw new MailError("invalid_cursor", "Cursor offset is invalid");
  }
  if (record.uid !== null && (typeof record.uid !== "number" || !Number.isSafeInteger(record.uid) || record.uid <= 0)) {
    throw new MailError("invalid_cursor", "Cursor uid is invalid");
  }
  return { v: 1, offset: record.offset, uid: record.uid };
}

function validatePayload(payload: CursorPayload): void {
  if (payload.v !== 1 || !Number.isSafeInteger(payload.offset) || payload.offset < 0) {
    throw new MailError("invalid_cursor", "Cannot encode cursor");
  }
  if (payload.uid !== null && (!Number.isSafeInteger(payload.uid) || payload.uid <= 0)) {
    throw new MailError("invalid_cursor", "Cannot encode cursor");
  }
}
