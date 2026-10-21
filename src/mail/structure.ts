export interface BodyNode {
  type: string;
  disposition?: string | null;
  parameters?: Record<string, string> | null;
  dispositionParameters?: Record<string, string> | null;
  id?: string | null;
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
