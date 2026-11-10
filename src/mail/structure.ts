export interface BodyNode {
  type: string;
  /**
   * IMAP body part number as reported by the parser. Not used for lookups:
   * numbers are computed from the tree shape (see walkParts).
   */
  part?: string | null;
  disposition?: string | null;
  parameters?: Record<string, string> | null;
  dispositionParameters?: Record<string, string> | null;
  /** Content-ID. */
  id?: string | null;
  /** Content-Transfer-Encoding, lower case. */
  encoding?: string | null;
  /** Encoded size in bytes, as reported by BODYSTRUCTURE. */
  size?: number | null;
  childNodes?: BodyNode[] | null;
}

function filenameOf(node: BodyNode): string | undefined {
  return node.dispositionParameters?.filename || node.parameters?.name || undefined;
}

function nodeIsAttachment(node: BodyNode): boolean {
  const type = node.type.toLowerCase();
  if (type.startsWith("multipart/")) return false;
  const disposition = (node.disposition ?? "").toLowerCase();
  if (disposition === "attachment") return true;
  if (type === "text/plain" || type === "text/html") return false;
  if (type === "message/rfc822" && !disposition && !filenameOf(node)) return false;
  return true;
}

/** Client-side attachment check from IMAP BODYSTRUCTURE. Multipart containers are walked. */
export function hasAttachments(node: BodyNode | null | undefined): boolean {
  if (!node || !node.type) return false;
  if (nodeIsAttachment(node)) return true;
  for (const child of node.childNodes ?? []) {
    if (hasAttachments(child)) return true;
  }
  return false;
}

export interface AttachmentPart {
  /** Position in the message's attachment list, starting at 0. */
  index: number;
  /** IMAP body part number to fetch. A single-part message is part "1". */
  part: string;
  node: BodyNode;
  filename: string | null;
  content_type: string;
  content_id: string | null;
}

function isMultipart(node: BodyNode): boolean {
  return node.type.toLowerCase().startsWith("multipart/");
}

/**
 * Walks the tree with IMAP part numbers computed from its shape (RFC 3501
 * 6.4.5), not taken from the parser: imapflow gives an encapsulated message
 * the number of its wrapper, and numbers the parts inside a top-level
 * message/rfc822 as if they were top-level. `part` is null only for a
 * multipart that is a message body (the root, or inside message/rfc822);
 * `visit` returns false to skip a node's children.
 */
function walkParts(root: BodyNode, visit: (node: BodyNode, part: string | null) => boolean): void {
  // A message body: a multipart is not numbered itself, its children are prefix.1, prefix.2 ...;
  // a single part is prefix.1, or "1" for the whole message.
  const body = (node: BodyNode, prefix: string | null) => {
    if (isMultipart(node)) visitNode(node, null, prefix);
    else visitNode(node, prefix ? `${prefix}.1` : "1", null);
  };
  const visitNode = (node: BodyNode, part: string | null, prefix: string | null) => {
    if (!node.type) return;
    if (!visit(node, part)) return;
    const children = node.childNodes ?? [];
    if (isMultipart(node)) {
      const base = part ?? prefix;
      children.forEach((child, i) => visitNode(child, base ? `${base}.${i + 1}` : String(i + 1), null));
    } else if (baseType(node.type) === "message/rfc822" && part && children[0]) {
      body(children[0], part);
    }
  };
  body(root, null);
}

/**
 * Attachments in document order, using the same rule as hasAttachments. An
 * attached message (message/rfc822 with a name or disposition) is one
 * attachment; its own parts are not listed separately.
 */
export function listAttachmentParts(root: BodyNode | null | undefined): AttachmentPart[] {
  const found: AttachmentPart[] = [];
  if (!root) return found;
  walkParts(root, (node, part) => {
    if (!nodeIsAttachment(node)) return true;
    if (part) {
      found.push({
        index: found.length,
        part,
        node,
        filename: filenameOf(node) ?? null,
        content_type: baseType(node.type),
        content_id: stripBrackets(node.id),
      });
    }
    return false;
  });
  return found;
}

/** Finds a leaf (non-multipart) node by part number. */
export function findPart(root: BodyNode | null | undefined, part: string): BodyNode | null {
  if (!root) return null;
  let hit: BodyNode | null = null;
  walkParts(root, (node, number) => {
    if (hit) return false;
    if (number === part && !isMultipart(node)) hit = node;
    return !hit;
  });
  return hit;
}

/** True when the message body is one part, which IMAP fetches as TEXT rather than "1". */
export function isSinglePart(root: BodyNode): boolean {
  return !isMultipart(root);
}

export function baseType(type: string): string {
  return (type.split(";")[0] ?? "").trim().toLowerCase();
}

function stripBrackets(value: string | null | undefined): string | null {
  if (!value) return null;
  const stripped = value.replace(/^<|>$/g, "").trim();
  return stripped || null;
}

export interface ListedAttachment {
  /** Pass to get_attachment as index. Null when the part could not be matched. */
  index: number | null;
  /** MIME part number; pass to get_attachment as part. */
  part: string | null;
  filename: string | null;
  content_type: string;
  size: number | null;
  content_id: string | null;
}

/**
 * Lists attachments in BODYSTRUCTURE order, which is what get_attachment's
 * index counts. A parsed attachment (from the message source) only lends its
 * name, decoded size and Content-ID to a part that is the same attachment:
 * the same type and no conflicting name or Content-ID, then, in order, the
 * same Content-ID, the same file name, or (for what is left) the same
 * position among equally many unnamed attachments of that type. Anything
 * ambiguous stays unmatched, so an index never carries another
 * attachment's details. Unmatched parsed attachments come last with index and
 * part null; parts the parser missed (for example past a partial fetch) are
 * still listed from BODYSTRUCTURE. With `partial`, sizes come from
 * BODYSTRUCTURE because the parser saw a cut-off message.
 */
export function listAttachments<T extends { filename: string | null; content_type: string; size: number | null; content_id: string | null }>(
  parsed: readonly T[],
  root: BodyNode | null | undefined,
  options: { partial?: boolean } = {},
): ListedAttachment[] {
  const parts = listAttachmentParts(root);
  const byPart = new Map<number, T>();
  const used = new Set<number>();
  const compatible = (attachment: T, part: AttachmentPart) =>
    baseType(attachment.content_type) === part.content_type &&
    !(attachment.filename && part.filename && normalizeName(attachment.filename) !== normalizeName(part.filename)) &&
    !(attachment.content_id && part.content_id && stripBrackets(attachment.content_id) !== part.content_id);
  const pair = (same: (attachment: T, part: AttachmentPart) => boolean) => {
    parsed.forEach((attachment, i) => {
      if (used.has(i)) return;
      const hit = parts.find((part) => !byPart.has(part.index) && compatible(attachment, part) && same(attachment, part));
      if (!hit) return;
      byPart.set(hit.index, attachment);
      used.add(i);
    });
  };
  pair((attachment, part) => Boolean(attachment.content_id && part.content_id));
  pair((attachment, part) => Boolean(attachment.filename && part.filename));
  // Whatever is left pairs in order only when both sides have the same number of that type.
  const types = new Set(parts.filter((part) => !byPart.has(part.index)).map((part) => part.content_type));
  for (const type of types) {
    const freeParts = parts.filter((part) => !byPart.has(part.index) && part.content_type === type);
    const freeParsed = parsed.map((attachment, i) => ({ attachment, i })).filter(({ attachment, i }) => !used.has(i) && baseType(attachment.content_type) === type);
    if (freeParts.length !== freeParsed.length) continue;
    if (!freeParts.every((part, k) => compatible(freeParsed[k]!.attachment, part))) continue;
    freeParts.forEach((part, k) => {
      byPart.set(part.index, freeParsed[k]!.attachment);
      used.add(freeParsed[k]!.i);
    });
  }
  const fromParts = parts.map((part): ListedAttachment => {
    const attachment = byPart.get(part.index);
    return {
      index: part.index,
      part: part.part,
      filename: attachment?.filename ?? part.filename,
      content_type: part.content_type,
      size: attachment && !options.partial ? attachment.size : estimatedSize(part.node),
      content_id: attachment?.content_id ?? part.content_id,
    };
  });
  return [
    ...fromParts,
    ...parsed.filter((_attachment, i) => !used.has(i)).map((attachment) => ({
      index: null,
      part: null,
      filename: attachment.filename,
      content_type: attachment.content_type,
      size: attachment.size,
      content_id: attachment.content_id,
    })),
  ];
}

function normalizeName(name: string): string {
  return name.normalize("NFC").trim().toLowerCase();
}

/** Decoded size from the encoded BODYSTRUCTURE size: base64 carries 3 bytes per 4 characters plus a CRLF per 76. */
export function estimatedSize(node: BodyNode): number | null {
  if (typeof node.size !== "number") return null;
  if ((node.encoding ?? "").toLowerCase() === "base64") return Math.floor(((node.size * 76) / 78) * 3 / 4);
  return node.size;
}
