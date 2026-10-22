/**
 * OpenMail admin CLI for operators of a multi-user deployment.
 *
 *   node dist/cli/admin.js <command> [--flag value ...]
 *
 * Secrets (passwords, API keys) are read from stdin or from a named
 * environment variable, never from argv, and are never printed.
 */
import { pathToFileURL } from "node:url";
import type Database from "better-sqlite3";
import { loadMasterKey } from "../crypto/index.js";
import { migrate, openDatabase, resolveDatabasePath } from "../db/index.js";
import { MailError, scrubSecret, toMailError } from "../errors.js";
import { createImapGateway, isAllowlistedInsecureHost, parseInsecureImapHosts, type ImapGateway } from "../mail/index.js";
import { resolveEndpoints, type ProviderPreset, type ZohoRegion } from "../mail/presets.js";
import { apiKeys, mailAccounts, users } from "../services/index.js";
import { parsePreset, parseZohoRegion } from "../services/validate.js";
import type { AccountCredentials } from "../store/types.js";

export const USAGE = `Usage: admin <command> [options]

  list-users
  create-user   --email <login email>                       password on stdin
  set-password  --email <login email>                       new password on stdin; signs out web sessions, keeps API keys
  list-accounts --user <login email>
  add-account   --user <login email> --name <name> --email <mailbox address>
                --preset <migadu|fastmail|zoho|icloud> [--username <u>] [--zoho-region <com|eu|in>]
                [--password-env <VAR>] [--skip-probe]        password on stdin unless --password-env
                --preset custom --imap-host <h> --imap-port <p> --plain
                                                            only for a host in OPENMAIL_INSECURE_IMAP_HOSTS
  import-key    --user <login email> --name <key name>      existing key on stdin
  delete-user   --email <login email> --yes                 removes the user, sessions, keys, mailboxes

Environment: OPENMAIL_MASTER_KEY, OPENMAIL_DB_PATH, OPENMAIL_INSECURE_IMAP_HOSTS.`;

export interface AdminIo {
  readSecret(): Promise<string>;
  env: Record<string, string | undefined>;
  out(line: string): void;
}

export interface AdminDeps {
  db: Database;
  masterKey: Buffer;
  imap: ImapGateway;
}

export function parseArgs(argv: readonly string[]): { command: string; flags: Map<string, string | true> } {
  const [command = "", ...rest] = argv;
  const flags = new Map<string, string | true>();
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i] ?? "";
    if (!arg.startsWith("--")) throw new MailError("invalid_input", `Unexpected argument: ${arg}`);
    const name = arg.slice(2);
    const next = rest[i + 1];
    if (next === undefined || next.startsWith("--")) {
      flags.set(name, true);
    } else {
      flags.set(name, next);
      i += 1;
    }
  }
  return { command, flags };
}

export async function runAdmin(argv: readonly string[], deps: AdminDeps, io: AdminIo): Promise<void> {
  const { command, flags } = parseArgs(argv);
  const text = (name: string): string => {
    const value = flags.get(name);
    if (typeof value !== "string" || value.trim() === "") {
      throw new MailError("invalid_input", `--${name} is required`);
    }
    return value.trim();
  };
  const optional = (name: string): string | undefined => {
    const value = flags.get(name);
    return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
  };

  switch (command) {
    case "list-users": {
      const rows = deps.db
        .prepare(
          `SELECT u.id, u.email,
                  (SELECT COUNT(*) FROM mail_accounts m WHERE m.user_id = u.id) AS accounts,
                  (SELECT COUNT(*) FROM api_keys k WHERE k.user_id = u.id AND k.revoked_at IS NULL) AS keys
           FROM users u ORDER BY u.created_at`,
        )
        .all() as Array<{ id: string; email: string; accounts: number; keys: number }>;
      for (const row of rows) io.out(`${row.email}\t${row.id}\taccounts=${row.accounts}\tactive_keys=${row.keys}`);
      io.out(`users=${rows.length}`);
      return;
    }
    case "create-user": {
      const password = await io.readSecret();
      const user = await users.create(deps.db, deps.masterKey, { email: text("email"), password });
      io.out(`created user ${user.email} ${user.id}`);
      return;
    }
    case "set-password": {
      const password = await io.readSecret();
      const email = text("email");
      const changed = await users.setPassword(deps.db, { email, password });
      io.out(`password updated for ${email.toLowerCase()} ${changed.id} (sessions signed out=${changed.sessions})`);
      return;
    }
    case "list-accounts": {
      const userId = userIdFor(deps.db, text("user"));
      const rows = mailAccounts.list(deps.db, userId);
      for (const row of rows) io.out(`${row.name}\t${row.id}\t${row.preset}\t${row.imapHost}`);
      io.out(`accounts=${rows.length}`);
      return;
    }
    case "add-account": {
      const userId = userIdFor(deps.db, text("user"));
      const preset = parsePreset(text("preset"));
      const insecureImapHosts = parseInsecureImapHosts(io.env.OPENMAIL_INSECURE_IMAP_HOSTS);
      let custom: { host: string; port: number } | undefined;
      if (preset === "custom") {
        // The CLI adds custom hosts only for operator-run internal servers on
        // the plain-IMAP allowlist (the reviewer demo). Everyone else uses the web form.
        const host = text("imap-host").toLowerCase();
        const port = Number(text("imap-port"));
        if (flags.get("plain") !== true || !isAllowlistedInsecureHost(host, insecureImapHosts)) {
          throw new MailError("invalid_input", "Custom hosts in the CLI must be plain IMAP hosts on OPENMAIL_INSECURE_IMAP_HOSTS");
        }
        if (!Number.isInteger(port) || port < 1 || port > 65535) throw new MailError("invalid_input", "--imap-port is invalid");
        custom = { host, port };
      }
      const zohoRegion = parseZohoRegion(optional("zoho-region"));
      const passwordEnv = optional("password-env");
      const password = passwordEnv ? (io.env[passwordEnv] ?? "") : await io.readSecret();
      if (!password) throw new MailError("invalid_input", "Mailbox password is empty");
      const email = text("email");
      const username = optional("username") ?? email;
      const name = text("name");
      if (flags.get("skip-probe") !== true) {
        await probe(deps.imap, {
          name,
          email,
          username,
          password,
          preset,
          ...(zohoRegion ? { zohoRegion } : {}),
          ...(custom ? { custom, insecureImapHosts } : {}),
        });
        io.out("imap login ok");
      }
      const added = mailAccounts.add(deps.db, deps.masterKey, {
        userId,
        name,
        email,
        username,
        preset,
        password,
        ...(zohoRegion ? { zohoRegion } : {}),
        ...(custom
          ? {
              imapHost: custom.host,
              imapPort: custom.port,
              imapSecure: false,
              smtpHost: custom.host,
              smtpPort: 3025,
              smtpSecure: false,
              smtpStarttls: false,
            }
          : {}),
      });
      io.out(`added account ${added.name} ${added.id}`);
      return;
    }
    case "import-key": {
      const userId = userIdFor(deps.db, text("user"));
      const token = await io.readSecret();
      const imported = apiKeys.importToken(deps.db, { userId, name: text("name"), token });
      io.out(`imported key ${imported.name} ${imported.id}`);
      return;
    }
    case "delete-user": {
      if (flags.get("yes") !== true) throw new MailError("invalid_input", "delete-user needs --yes");
      const email = text("email");
      const userId = userIdFor(deps.db, email);
      const removed = users.remove(deps.db, userId);
      io.out(
        `deleted user ${email.trim().toLowerCase()} ${userId} (accounts=${removed.accounts} keys=${removed.keys} sessions=${removed.sessions})`,
      );
      return;
    }
    default:
      throw new MailError("invalid_input", USAGE);
  }
}

function userIdFor(db: Database, email: string): string {
  const row = db.prepare("SELECT id FROM users WHERE email = ?").get(email.trim().toLowerCase()) as
    | { id: string }
    | undefined;
  if (!row) throw new MailError("not_found", "User was not found");
  return row.id;
}

async function probe(
  imap: ImapGateway,
  input: {
    name: string;
    email: string;
    username: string;
    password: string;
    preset: ProviderPreset;
    zohoRegion?: ZohoRegion;
    custom?: { host: string; port: number };
    insecureImapHosts?: readonly string[];
  },
): Promise<void> {
  const endpoints = input.custom
    ? {
        imap: { host: input.custom.host, port: input.custom.port, secure: false },
        smtp: { host: input.custom.host, port: 3025, secure: false, starttls: false },
      }
    : resolveEndpoints({ preset: input.preset, ...(input.zohoRegion ? { zohoRegion: input.zohoRegion } : {}) });
  const credentials: AccountCredentials = {
    id: "probe",
    label: input.name,
    email: input.email,
    preset: input.preset,
    username: input.username,
    password: input.password,
    imap: endpoints.imap,
    smtp: endpoints.smtp,
    allowInsecureLocalhost: false,
    ...(input.insecureImapHosts ? { insecureImapHosts: input.insecureImapHosts } : {}),
  };
  try {
    await imap.withClient(credentials, async () => undefined);
  } catch (err) {
    const mail = toMailError(err, input.password);
    throw new MailError(mail.code, `IMAP login failed: ${scrubSecret(mail.message, input.password)}`);
  }
}

async function readStdinSecret(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    if (chunks.reduce((n, c) => n + c.length, 0) > 4096) throw new MailError("invalid_input", "Secret is too long");
  }
  return Buffer.concat(chunks).toString("utf8").replace(/\r?\n$/, "");
}

const invoked = process.argv[1];
if (invoked && import.meta.url === pathToFileURL(invoked).href) {
  const db = openDatabase(resolveDatabasePath(process.env));
  migrate(db);
  runAdmin(
    process.argv.slice(2),
    { db, masterKey: loadMasterKey(process.env.OPENMAIL_MASTER_KEY), imap: createImapGateway() },
    { readSecret: readStdinSecret, env: process.env, out: (line) => console.log(line) },
  )
    .then(() => db.close())
    .catch((err: unknown) => {
      db.close();
      console.error(err instanceof MailError || err instanceof Error ? err.message : "Admin command failed");
      process.exit(1);
    });
}
