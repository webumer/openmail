export interface MailAddress {
  name: string | null;
  address: string;
}

export function envelopeAddresses(
  list: readonly { name?: string | undefined; address?: string | undefined }[] | undefined,
): MailAddress[] {
  if (!list) return [];
  const out: MailAddress[] = [];
  for (const entry of list) {
    if (!entry.address) continue;
    const name = entry.name?.trim();
    out.push({ name: name ? name : null, address: entry.address });
  }
  return out;
}
