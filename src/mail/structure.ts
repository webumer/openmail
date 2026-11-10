export interface BodyNode {
  type: string;
  /** IMAP body part number ("1", "2.1"). Unset for a multipart root and for a single-part message. */
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

/** The part number of a node; a single-part message's root is part 1. */
function partNumber(node: BodyNode, isRoot: boolean): string | null {
  if (node.part) return node.part;
  return isRoot && !node.childNodes?.length ? "1" : null;
}

/**
 * Attachments in document order, using the same rule as hasAttachments. An
 * attached message (message/rfc822 with a name or disposition) is one
 * attachment; its own parts are not listed separately.
 */
export function listAttachmentParts(root: BodyNode | null | undefined): AttachmentPart[] {
  const found: AttachmentPart[] = [];
  const walk = (node: BodyNode, isRoot: boolean) => {
    if (!node.type) return;
    if (nodeIsAttachment(node)) {
      const part = partNumber(node, isRoot);
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
      return;
    }
    for (const child of node.childNodes ?? []) walk(child, false);
  };
  if (root) walk(root, true);
  return found;
}

/** Finds a leaf (non-multipart) node by part number. */
export function findPart(root: BodyNode | null | undefined, part: string): BodyNode | null {
  if (!root) return null;
  const walk = (node: BodyNode, isRoot: boolean): BodyNode | null => {
    if (!node.type.toLowerCase().startsWith("multipart/") && partNumber(node, isRoot) === part) return node;
    for (const child of node.childNodes ?? []) {
      const hit = walk(child, false);
      if (hit) return hit;
    }
    return null;
  };
  return walk(root, true);
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
 * index counts, using the parsed message's names, decoded sizes and
 * Content-IDs where a parsed attachment matches (same type, and same name
 * when both have one). Parsed attachments with no matching part come last
 * with index and part null; parts the parser missed (for example past a
 * partial fetch) are still listed from BODYSTRUCTURE.
 */
export function listAttachments<T extends { filename: string | null; content_type: string; size: number | null; content_id: string | null }>(
  parsed: readonly T[],
  root: BodyNode | null | undefined,
): ListedAttachment[] {
  const parts = listAttachmentParts(root);
  const matched = new Map<number, T>();
  const unmatched: T[] = [];
  for (const attachment of parsed) {
    const type = baseType(attachment.content_type);
    const free = parts.filter((part) => !matched.has(part.index) && part.content_type === type);
    const hit = free.find((part) => part.filename === attachment.filename || part.filename === null || attachment.filename === null) ?? free[0];
    if (hit) matched.set(hit.index, attachment);
    else unmatched.push(attachment);
  }
  const fromParts = parts.map((part): ListedAttachment => {
    const attachment = matched.get(part.index);
    return {
      index: part.index,
      part: part.part,
      filename: attachment?.filename ?? part.filename,
      content_type: attachment?.content_type ?? part.content_type,
      size: attachment ? attachment.size : estimatedSize(part.node),
      content_id: attachment ? attachment.content_id : part.content_id,
    };
  });
  return [
    ...fromParts,
    ...unmatched.map((attachment) => ({
      index: null,
      part: null,
      filename: attachment.filename,
      content_type: attachment.content_type,
      size: attachment.size,
      content_id: attachment.content_id,
    })),
  ];
}

/** Decoded size from the encoded BODYSTRUCTURE size: base64 carries 3 bytes per 4 characters plus a CRLF per 76. */
export function estimatedSize(node: BodyNode): number | null {
  if (typeof node.size !== "number") return null;
  if ((node.encoding ?? "").toLowerCase() === "base64") return Math.floor(((node.size * 76) / 78) * 3 / 4);
  return node.size;
}
