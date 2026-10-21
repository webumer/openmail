import { ImapFlow } from "imapflow";
import MailComposer from "nodemailer/lib/mail-composer/index.js";
import { errorText, scrubSecret } from "../errors.js";
import { assertImapTransportAllowed } from "../mail/tls.js";
import type { AccountCredentials } from "../store/types.js";
import { DEMO_ADDRESS, demoMessages, messageId, type DemoMessage } from "./messages.js";

export interface DemoMailboxConfig {
  host: string;
  port: number;
  username: string;
  password: string;
  insecureImapHosts: readonly string[];
}

/** Reads OPENMAIL_DEMO_IMAP_* settings. Returns null when the demo mailbox is not configured. */
export function demoConfigFromEnv(
  env: Record<string, string | undefined>,
  insecureImapHosts: readonly string[],
): DemoMailboxConfig | null {
  const host = env.OPENMAIL_DEMO_IMAP_HOST?.trim();
  const password = env.OPENMAIL_DEMO_PASSWORD ?? "";
  if (!host || !password) return null;
  const port = Number(env.OPENMAIL_DEMO_IMAP_PORT ?? "3143");
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { host, port, username: env.OPENMAIL_DEMO_IMAP_USER?.trim() || "demo", password, insecureImapHosts };
}

export async function buildRaw(message: DemoMessage, now: number): Promise<Buffer> {
  const composer = new MailComposer({
    from: message.from,
    to: message.to,
    subject: message.subject,
    date: new Date(now - message.ageMinutes * 60_000),
    messageId: messageId(message.idKey ?? message.key),
    text: message.text,
    ...(message.html ? { html: message.html } : {}),
    ...(message.inReplyTo ? { inReplyTo: message.inReplyTo } : {}),
    ...(message.references ? { references: message.references } : {}),
    ...(message.attachments
      ? {
          attachments: message.attachments.map((a) => ({
            filename: a.filename,
            contentType: a.contentType,
            content: a.content,
          })),
        }
      : {}),
    headers: { "X-OpenMail-Demo": "fictional sample message" },
  });
  return composer.compile().build();
}

/**
 * Appends any demo message whose Message-ID is missing from its folder.
 * Safe to run repeatedly: a fully seeded mailbox is left untouched.
 * @returns number of messages appended.
 */
export async function seedDemoMailbox(config: DemoMailboxConfig, now = Date.now()): Promise<number> {
  const credentials: AccountCredentials = {
    id: "demo-seed",
    label: "Demo mailbox",
    email: DEMO_ADDRESS,
    preset: "custom",
    username: config.username,
    password: config.password,
    imap: { host: config.host, port: config.port, secure: false },
    smtp: { host: config.host, port: 3025, secure: false, starttls: false },
    allowInsecureLocalhost: false,
    insecureImapHosts: config.insecureImapHosts,
  };
  // Same rule as every other connection: plain IMAP only for allowlisted hosts.
  assertImapTransportAllowed(credentials);
  const client = new ImapFlow({
    host: config.host,
    port: config.port,
    secure: false,
    doSTARTTLS: false,
    auth: { user: config.username, pass: config.password },
    logger: false,
    disableAutoIdle: true,
  });
  await client.connect();
  let appended = 0;
  try {
    const messages = demoMessages();
    const folders = [...new Set(messages.map((m) => m.folder))];
    const existing = new Set((await client.list()).map((f) => f.path));
    for (const folder of folders) {
      if (!existing.has(folder)) await client.mailboxCreate(folder);
      const present = await messageIdsIn(client, folder);
      for (const message of messages.filter((m) => m.folder === folder)) {
        const id = messageId(message.idKey ?? message.key);
        if (present.has(id)) continue;
        const raw = await buildRaw(message, now);
        await client.append(folder, raw, message.seen ? ["\\Seen"] : [], new Date(now - message.ageMinutes * 60_000));
        present.add(id);
        appended += 1;
      }
    }
  } finally {
    await client.logout().catch(() => undefined);
  }
  return appended;
}

async function messageIdsIn(client: ImapFlow, folder: string): Promise<Set<string>> {
  const ids = new Set<string>();
  const lock = await client.getMailboxLock(folder, { readOnly: true });
  try {
    const status = client.mailbox;
    if (status && typeof status === "object" && status.exists === 0) return ids;
    for await (const message of client.fetch("1:*", { envelope: true })) {
      const id = message.envelope?.messageId;
      if (id) ids.add(id);
    }
  } finally {
    lock.release();
  }
  return ids;
}

/**
 * Keeps the demo mailbox seeded. GreenMail keeps mail in memory, so a
 * container restart empties it; this re-checks on a timer and refills.
 * Logs counts only, never message content or credentials.
 */
export const DEFAULT_RESEED_MS = 2 * 60_000;

export function reseedIntervalFromEnv(env: Record<string, string | undefined>): number {
  const seconds = Number(env.OPENMAIL_DEMO_RESEED_SECONDS ?? "");
  return Number.isInteger(seconds) && seconds >= 30 && seconds <= 86_400 ? seconds * 1000 : DEFAULT_RESEED_MS;
}

export function startDemoSeeder(config: DemoMailboxConfig, intervalMs = DEFAULT_RESEED_MS): () => void {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const appended = await seedDemoMailbox(config);
      if (appended > 0) console.log(`Demo mailbox seeded: ${appended} message(s) appended`);
    } catch (err) {
      console.error(`Demo mailbox seeding failed: ${scrubSecret(errorText(err), config.password)}`);
    } finally {
      running = false;
    }
  };
  const first = setTimeout(() => void tick(), 5_000);
  const timer = setInterval(() => void tick(), intervalMs);
  first.unref();
  timer.unref();
  return () => {
    clearTimeout(first);
    clearInterval(timer);
  };
}
