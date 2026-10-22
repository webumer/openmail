import net from "node:net";
import { describe, expect, it } from "vitest";
import { seedDemoMailbox } from "../../src/demo/seed.js";
import { demoMessages } from "../../src/demo/messages.js";
import { createImapGateway } from "../../src/mail/imap-gateway.js";
import { listFolders, readMessage, readThread, searchMessages, type MailDeps } from "../../src/mail/operations.js";
import type { AccountCredentials, CredentialStore } from "../../src/store/types.js";

const IMAP_PORT = Number(process.env.OPENMAIL_TEST_IMAP_PORT ?? "13143");
/** Second GreenMail user from docker-compose.test.yml, reserved for this test. */
const DEMO = { host: "127.0.0.1", port: IMAP_PORT, username: "demo", password: "demo-test-pass" };

const live = await new Promise<boolean>((resolve) => {
  const socket = net.connect(IMAP_PORT, "127.0.0.1");
  socket.once("connect", () => (socket.destroy(), resolve(true)));
  socket.once("error", () => resolve(false));
});

function deps(allowlist: string[]): MailDeps {
  const account: AccountCredentials = {
    id: "demo",
    label: "Demo mailbox",
    email: "demo@demo.openmail.tools",
    preset: "custom",
    username: DEMO.username,
    password: DEMO.password,
    imap: { host: DEMO.host, port: DEMO.port, secure: false },
    smtp: { host: DEMO.host, port: 3025, secure: false, starttls: false },
    allowInsecureLocalhost: false,
    sendEnabled: false,
    smtpAuth: { user: DEMO.username, pass: DEMO.password },
    autoSavesSent: false,
    insecureImapHosts: allowlist,
  };
  const store: CredentialStore = {
    async listAccounts() {
      return [{ id: "demo", label: account.label, email: account.email, preset: "custom", imapHost: DEMO.host, sendEnabled: false }];
    },
    async getAccount(_user, id) {
      return id === "demo" ? account : null;
    },
  };
  return { store, imap: createImapGateway() };
}

describe.skipIf(!live)("demo mailbox seeding", () => {
  it("seeds once, is idempotent, and is readable through the read-only tools via the allowlist", async () => {
    await seedDemoMailbox({ ...DEMO, insecureImapHosts: ["127.0.0.1"] });
    expect(await seedDemoMailbox({ ...DEMO, insecureImapHosts: ["127.0.0.1"] })).toBe(0);

    const blocked = await listFolders(deps([]), "u", "demo");
    expect(blocked.ok).toBe(false);

    const d = deps(["127.0.0.1"]);
    const folders = await listFolders(d, "u", "demo");
    expect(folders.ok).toBe(true);
    const inbox = folders.ok ? folders.data.find((f) => f.path === "INBOX") : undefined;
    const expectedInbox = demoMessages().filter((m) => m.folder === "INBOX");
    expect(inbox?.messages).toBe(expectedInbox.length);
    expect(inbox?.unseen).toBe(expectedInbox.filter((m) => !m.seen).length);
    expect(folders.ok && folders.data.some((f) => f.path === "Sent")).toBe(true);

    const invoice = await searchMessages(d, "u", "demo", { subject: "invoice", has_attachment: true });
    expect(invoice.ok && invoice.data.messages.length).toBe(1);
    const uid = invoice.ok ? invoice.data.messages[0]!.uid : 0;
    const read = await readMessage(d, "u", "demo", "INBOX", uid);
    expect(read.ok && read.data.attachments.map((a) => a.filename)).toEqual(["invoice-NW-2026-1042.pdf"]);

    const leo = await searchMessages(d, "u", "demo", { from: "leo@acme.example" });
    const leoUid = leo.ok ? leo.data.messages[0]!.uid : 0;
    const thread = await readThread(d, "u", "demo", "INBOX", leoUid);
    expect(thread.ok && thread.data.messages.length).toBe(3);

    // GreenMail matches FROM only against a full address; OpenMail falls back to matching names and parts.
    for (const filters of [{ from: "priya", subject: "offsite" }, { from: "Priya Raman" }, { from: "PRIYA@ACME" }]) {
      const priya = await searchMessages(d, "u", "demo", filters);
      expect(priya.ok && priya.data.messages.map((m) => m.subject)).toEqual(["Q4 planning offsite: date and venue"]);
    }
    const toDemo = await searchMessages(d, "u", "demo", { to: "demo", from: "priya", subject: "offsite" });
    expect(toDemo.ok && toDemo.data.messages.map((m) => m.subject)).toEqual(["Q4 planning offsite: date and venue"]);
    const nobody = await searchMessages(d, "u", "demo", { from: "nobody-here", subject: "offsite" });
    expect(nobody.ok && nobody.data.messages).toEqual([]);

    const unread = await searchMessages(d, "u", "demo", { unread: true });
    expect(unread.ok && unread.data.messages.length).toBe(expectedInbox.filter((m) => !m.seen).length);
  });
});
