const ID_PATTERN = /<[^<>\s]+>/g;

export type ThreadAlgorithm = "REFS" | "REFERENCES";

export function threadAlgorithm(capabilities: Iterable<string>): ThreadAlgorithm | null {
  const caps = new Set([...capabilities].map((capability) => capability.toUpperCase()));
  if (caps.has("THREAD=REFS")) return "REFS";
  if (caps.has("THREAD=REFERENCES")) return "REFERENCES";
  return null;
}

export function canonicalMessageId(value: string): string {
  const trimmed = value.trim();
  const bracketed = trimmed.match(ID_PATTERN);
  const first = bracketed?.[0];
  if (first) return first;
  if (trimmed.startsWith("<") && trimmed.endsWith(">") && trimmed.length > 2) return trimmed;
  if (trimmed.includes("@")) return `<${trimmed.replace(/^<|>$/g, "")}>`;
  return trimmed;
}

export function extractMessageIds(value: string | null | undefined): string[] {
  if (!value) return [];
  const matches = value.match(ID_PATTERN);
  if (matches && matches.length > 0) {
    const ids: string[] = [];
    for (const match of matches) {
      const id = canonicalMessageId(match);
      if (!ids.includes(id)) ids.push(id);
    }
    return ids;
  }
  const trimmed = value.trim();
  return trimmed ? [canonicalMessageId(trimmed)] : [];
}

export function collectThreadIds(input: {
  messageId?: string | null;
  inReplyTo?: string | null;
  references?: string | readonly string[] | null;
}): string[] {
  const ids: string[] = [];
  const push = (value: string | null | undefined) => {
    for (const id of extractMessageIds(value)) {
      if (!ids.includes(id)) ids.push(id);
    }
  };
  push(input.messageId);
  push(input.inReplyTo);
  const references = input.references;
  if (typeof references === "string" || references == null) {
    push(references);
  } else {
    for (const reference of references) push(reference);
  }
  return ids;
}

/** Flatten an untagged THREAD payload into one UID list per top-level thread. */
export function parseThreadResponse(attributes: unknown): number[][] {
  if (!Array.isArray(attributes)) return [];
  const threads: number[][] = [];
  for (const entry of attributes) {
    const uids: number[] = [];
    collectUids(entry, uids);
    if (uids.length > 0) threads.push(uids);
  }
  return threads;
}

export function threadContaining(threads: readonly (readonly number[])[], seedUid: number): number[] | null {
  const found = threads.find((thread) => thread.includes(seedUid));
  return found ? [...found] : null;
}

export function limitThreadUids(
  uids: readonly number[],
  seedUid: number,
  cap: number,
): { uids: number[]; truncated: boolean } {
  const unique: number[] = [];
  for (const uid of uids) {
    if (!Number.isSafeInteger(uid) || uid <= 0 || unique.includes(uid)) continue;
    unique.push(uid);
  }
  if (!unique.includes(seedUid) && Number.isSafeInteger(seedUid) && seedUid > 0) unique.push(seedUid);
  if (unique.length <= cap) return { uids: unique, truncated: false };
  const others = unique.filter((uid) => uid !== seedUid).sort((a, b) => a - b).slice(0, Math.max(0, cap - 1));
  const kept = cap > 0 && unique.includes(seedUid) ? [seedUid, ...others] : others.slice(0, cap);
  return { uids: kept, truncated: true };
}

function collectUids(node: unknown, into: number[]): void {
  if (typeof node === "number") {
    if (Number.isSafeInteger(node) && node > 0) into.push(node);
    return;
  }
  if (typeof node === "string" && /^\d+$/.test(node)) {
    const value = Number(node);
    if (Number.isSafeInteger(value) && value > 0) into.push(value);
    return;
  }
  if (Array.isArray(node)) {
    for (const child of node) collectUids(child, into);
    return;
  }
  if (node && typeof node === "object" && "value" in node) {
    collectUids((node as { value?: unknown }).value, into);
  }
}
