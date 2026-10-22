/**
 * Fixed, clearly fictional demo messages for the reviewer demo mailbox.
 * Every address uses a reserved example domain (RFC 2606) or demo.openmail.tools.
 */
export const DEMO_DOMAIN = "demo.openmail.tools";
export const DEMO_ADDRESS = `demo@${DEMO_DOMAIN}`;
export const SEED_VERSION = "v1";

export interface DemoAttachment {
  filename: string;
  contentType: string;
  content: Buffer;
}

export interface DemoMessage {
  key: string;
  /** Message-ID key when the same message is stored in two folders. */
  idKey?: string;
  folder: "INBOX" | "Sent";
  from: string;
  to: string;
  subject: string;
  /** Minutes before the seed time. */
  ageMinutes: number;
  seen: boolean;
  text: string;
  html?: string;
  inReplyTo?: string;
  references?: string[];
  attachments?: DemoAttachment[];
}

export function messageId(key: string): string {
  return `<${SEED_VERSION}.${key}@${DEMO_DOMAIN}>`;
}

/** A one-page PDF with a short invoice summary, built by hand (no dependency). */
export function invoicePdf(): Buffer {
  const lines = [
    "Northwind Cloud Hosting - Invoice NW-2026-1042",
    "Bill to: Demo Account (demo@demo.openmail.tools)",
    "Plan: Starter VPS x1 ............ USD 12.00",
    "Backups ......................... USD  2.40",
    "Total due ....................... USD 14.40",
    "This is a fictional demo invoice. No payment is due.",
  ];
  const text = lines
    .map((line, i) => `BT /F1 12 Tf 56 ${760 - i * 22} Td (${line.replace(/[\\()]/g, "\\$&")}) Tj ET`)
    .join("\n");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${Buffer.byteLength(text)} >>\nstream\n${text}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, "latin1");
}

const DAY = 24 * 60;

export function demoMessages(): DemoMessage[] {
  const thread1 = messageId("offsite-1");
  const thread2 = messageId("offsite-2");
  return [
    {
      key: "welcome",
      folder: "INBOX",
      from: "OpenMail Demo <hello@demo.openmail.tools>",
      to: DEMO_ADDRESS,
      subject: "Welcome to the OpenMail demo mailbox",
      ageMinutes: 6 * DAY,
      seen: true,
      text: "Hi there,\n\nThis mailbox contains a handful of fictional messages so you can try OpenMail: list folders, search, read a message, read a thread, and send a reply.\n\nNothing here is real. The read tools never change this mailbox. The demo can also send replies, which only reach an isolated demo mail server, never the internet.\n\nThe OpenMail demo",
    },
    {
      key: "newsletter-weekly-byte",
      folder: "INBOX",
      from: "The Weekly Byte <newsletter@weeklybyte.example>",
      to: DEMO_ADDRESS,
      subject: "The Weekly Byte #87: SQLite at the edge, tiny containers, and more",
      ageMinutes: 2 * DAY + 180,
      seen: true,
      text: "THE WEEKLY BYTE - Issue 87\n\n1. Why teams are moving small services to SQLite\n2. Five ways to shrink a container image\n3. Reader question: how do you rotate API keys without downtime?\n\nYou are receiving this because you subscribed at weeklybyte.example. Unsubscribe any time.",
      html: "<h1>The Weekly Byte - Issue 87</h1><ol><li>Why teams are moving small services to SQLite</li><li>Five ways to shrink a container image</li><li>Reader question: how do you rotate API keys without downtime?</li></ol><p>You are receiving this because you subscribed at weeklybyte.example.</p>",
    },
    {
      key: "newsletter-trailhead",
      folder: "INBOX",
      from: "Trailhead Outfitters <deals@trailhead.example>",
      to: DEMO_ADDRESS,
      subject: "Autumn sale: 20% off rain shells this weekend",
      ageMinutes: 26 * 60,
      seen: false,
      text: "Autumn is here. Take 20% off all rain shells and insulated jackets until Sunday.\n\nUse code AUTUMN20 at checkout (demo code, not valid anywhere).\n\nTrailhead Outfitters, 1 Example Way, Springfield",
    },
    {
      key: "invoice",
      folder: "INBOX",
      from: "Northwind Billing <billing@northwind.example>",
      to: DEMO_ADDRESS,
      subject: "Your invoice NW-2026-1042 is ready",
      ageMinutes: 3 * DAY,
      seen: true,
      text: "Hello,\n\nYour invoice NW-2026-1042 for USD 14.40 is attached as a PDF.\n\nThis is a fictional demo invoice and no payment is due.\n\nNorthwind Cloud Hosting",
      attachments: [{ filename: "invoice-NW-2026-1042.pdf", contentType: "application/pdf", content: invoicePdf() }],
    },
    {
      key: "offsite-1",
      folder: "INBOX",
      from: "Priya Raman <priya@acme.example>",
      to: `${DEMO_ADDRESS}, Leo Martins <leo@acme.example>`,
      subject: "Q4 planning offsite: date and venue",
      ageMinutes: 4 * DAY,
      seen: true,
      text: "Hi both,\n\nI'd like to hold the Q4 planning offsite on the 14th. Two venue options: the lakeside hall (fits 20) or the library annex (fits 12, cheaper).\n\nAny preference by Thursday?\n\nPriya",
    },
    {
      key: "offsite-2",
      folder: "Sent",
      from: `Demo User <${DEMO_ADDRESS}>`,
      to: "Priya Raman <priya@acme.example>, Leo Martins <leo@acme.example>",
      subject: "Re: Q4 planning offsite: date and venue",
      ageMinutes: 4 * DAY - 90,
      seen: true,
      inReplyTo: thread1,
      references: [thread1],
      text: "The 14th works for me. I'd vote for the lakeside hall, since we may have guests.\n\n> I'd like to hold the Q4 planning offsite on the 14th.",
    },
    {
      key: "offsite-2-inbox",
      idKey: "offsite-2",
      folder: "INBOX",
      from: `Demo User <${DEMO_ADDRESS}>`,
      to: "Priya Raman <priya@acme.example>, Leo Martins <leo@acme.example>",
      subject: "Re: Q4 planning offsite: date and venue",
      ageMinutes: 4 * DAY - 90,
      seen: true,
      inReplyTo: thread1,
      references: [thread1],
      text: "The 14th works for me. I'd vote for the lakeside hall, since we may have guests.\n\n> I'd like to hold the Q4 planning offsite on the 14th.",
    },
    {
      key: "offsite-3",
      folder: "INBOX",
      from: "Leo Martins <leo@acme.example>",
      to: `Priya Raman <priya@acme.example>, ${DEMO_ADDRESS}`,
      subject: "Re: Q4 planning offsite: date and venue",
      ageMinutes: 3 * DAY + 600,
      seen: false,
      inReplyTo: thread2,
      references: [thread1, thread2],
      text: "Lakeside hall gets my vote too. I can book it today if nobody objects, and I'll send a calendar hold for 09:30-16:00.\n\nLeo",
    },
    {
      key: "shipping",
      folder: "INBOX",
      from: "Parcel Express <updates@parcel.example>",
      to: DEMO_ADDRESS,
      subject: "Your package is out for delivery",
      ageMinutes: 5 * 60,
      seen: false,
      text: "Good news: your package (tracking DEMO-000123) is out for delivery and should arrive today between 12:00 and 16:00.\n\nThis is a fictional demo notification.",
    },
    {
      key: "security",
      folder: "INBOX",
      from: "Example Code Host <noreply@codehost.example>",
      to: DEMO_ADDRESS,
      subject: "A new SSH key was added to your account",
      ageMinutes: 30 * 60,
      seen: true,
      text: "A new SSH key named 'laptop-2026' was added to your Example Code Host account.\n\nIf this was you, no action is needed. This is a fictional demo notice.",
    },
    {
      key: "meetup",
      folder: "INBOX",
      from: "City Tech Meetup <events@meetup.example>",
      to: DEMO_ADDRESS,
      subject: "Reminder: Thursday meetup - building MCP servers",
      ageMinutes: 90,
      seen: false,
      text: "See you Thursday at 18:30 for talks on building Model Context Protocol servers, followed by pizza.\n\nVenue: Example Library, Room 2. This is a fictional demo event.",
    },
  ];
}
