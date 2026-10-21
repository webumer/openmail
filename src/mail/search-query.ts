import type { SearchObject } from "imapflow";
import { MailError } from "../errors.js";

export interface SearchFilters {
  from?: string;
  to?: string;
  subject?: string;
  text?: string;
  since?: string;
  before?: string;
  unread?: boolean;
}

export function buildSearchQuery(filters: SearchFilters): SearchObject {
  const query: SearchObject = {};
  const from = blankToUndefined(filters.from);
  const to = blankToUndefined(filters.to);
  const subject = blankToUndefined(filters.subject);
  const text = blankToUndefined(filters.text);
  if (from) query.from = from;
  if (to) query.to = to;
  if (subject) query.subject = subject;
  if (text) query.text = text;
  if (filters.since) query.since = parseSearchDate(filters.since, "since");
  if (filters.before) query.before = parseSearchDate(filters.before, "before");
  if (filters.unread === true) query.seen = false;
  if (Object.keys(query).length === 0) query.all = true;
  return query;
}

export function parseSearchDate(value: string, label: string): Date {
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  const parsed = dateOnly ? new Date(`${value.trim()}T00:00:00.000Z`) : new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new MailError("invalid_argument", `${label} is not a valid date`);
  }
  return parsed;
}

function blankToUndefined(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
