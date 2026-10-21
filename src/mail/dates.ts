const NAMED_OFFSETS: Record<string, string> = {
  UT: "+00:00",
  UTC: "+00:00",
  GMT: "+00:00",
  Z: "+00:00",
  EST: "-05:00",
  EDT: "-04:00",
  CST: "-06:00",
  CDT: "-05:00",
  MST: "-07:00",
  MDT: "-06:00",
  PST: "-08:00",
  PDT: "-07:00",
};

export interface NormalizedDate {
  /** ISO-8601 instant in UTC with a Z suffix. */
  utc: string;
  /** Original numeric offset, `+05:00` style, or null when the zone was not in the source. */
  original_offset: string | null;
  /** Raw Date header, or the UTC instant when no raw header was available. */
  original: string;
}

interface OffsetParse {
  offset: string | null;
  invalid: boolean;
}

export function extractOffset(raw: string): OffsetParse {
  const stripped = raw.replace(/\([^)]*\)/g, " ").trim();
  const numeric = stripped.match(/([+-])(\d{2}):?(\d{2})\s*$/);
  if (numeric) {
    const hours = numeric[2];
    const minutes = numeric[3];
    if (hours === undefined || minutes === undefined) return { offset: null, invalid: true };
    const hh = Number(hours);
    const mm = Number(minutes);
    if (hh > 23 || mm > 59) return { offset: null, invalid: true };
    return { offset: `${numeric[1]}${hours}:${minutes}`, invalid: false };
  }
  if (/Z$/i.test(stripped) && !/[A-Za-z]Z$/i.test(stripped)) {
    return { offset: "+00:00", invalid: false };
  }
  const named = stripped.match(/(?:^|\s)(UT|UTC|GMT|EST|EDT|CST|CDT|MST|MDT|PST|PDT)\s*$/i);
  if (named) {
    const token = named[1]?.toUpperCase();
    if (!token) return { offset: null, invalid: false };
    return { offset: NAMED_OFFSETS[token] ?? null, invalid: false };
  }
  return { offset: null, invalid: false };
}

/**
 * Normalize a Date header or a Date instant.
 * A raw header wins over a Date object so the original offset is preserved.
 * An out-of-range numeric offset (`+0560`) yields null rather than a shifted instant.
 */
export function normalizeDate(
  input: Date | string | null | undefined,
  rawHeader?: string | null,
): NormalizedDate | null {
  const raw = rawHeader?.trim() ? rawHeader.trim() : null;
  if (raw || typeof input === "string") {
    const original = raw ?? (typeof input === "string" ? input.trim() : "");
    if (!original) return null;
    const zone = extractOffset(original);
    if (zone.invalid) return null;
    const instant = new Date(original);
    if (Number.isNaN(instant.getTime())) return null;
    return { utc: instant.toISOString(), original_offset: zone.offset, original };
  }
  if (input instanceof Date) {
    if (Number.isNaN(input.getTime())) return null;
    const utc = input.toISOString();
    return { utc, original_offset: null, original: utc };
  }
  return null;
}

/** Pull one header value out of a raw header block (folded lines included). */
export function headerValue(block: string, name: string): string | null {
  const unfolded: string[] = [];
  let current: string | null = null;
  for (const line of block.split(/\r?\n/)) {
    if (/^[ \t]/.test(line) && current !== null) {
      current += ` ${line.trim()}`;
      continue;
    }
    if (current !== null) unfolded.push(current);
    current = line;
  }
  if (current !== null && current.trim()) unfolded.push(current);
  const prefix = `${name.toLowerCase()}:`;
  const found = unfolded.find((line) => line.toLowerCase().startsWith(prefix));
  if (!found) return null;
  const value = found.slice(prefix.length).trim();
  return value || null;
}
