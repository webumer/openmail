import type { ApiKeySummary, MailAccountSummary } from "../services/index.js";
import { PROVIDER_PRESETS, ZOHO_REGIONS } from "../mail/presets.js";
import type { AccountDraft } from "./forms.js";
import { escapeHtml } from "./html.js";

export const SUPPORT_EMAIL = "support@openmail.tools";

export function layout(title: string, body: string, options?: { csrf?: string; script?: boolean }): string {
  const logout =
    options?.csrf === undefined
      ? ""
      : `<form method="post" action="/logout"><input type="hidden" name="_csrf" value="${escapeHtml(options.csrf)}"><button class="secondary" type="submit">Log out</button></form>`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<link rel="icon" type="image/svg+xml" href="/logo.svg">
<link rel="icon" type="image/png" href="/logo.png">
<link rel="apple-touch-icon" href="/logo.png">
<link rel="stylesheet" href="/static/style.css">
</head>
<body>
<header class="top"><a class="brand" href="/"><img src="/logo.svg" alt="" width="28" height="28">OpenMail</a>${logout}</header>
<main>
${body}
</main>
<footer class="foot"><a href="/privacy">Privacy</a> · <a href="/terms">Terms</a> · <a href="/reviewers">Reviewer guide</a> · <a href="mailto:${SUPPORT_EMAIL}">${SUPPORT_EMAIL}</a></footer>
${options?.script ? '<script src="/static/app.js"></script>' : ""}
</body>
</html>`;
}

export function homePage(input: { email: string | null; csrf?: string; notice?: string }): string {
  const notice = input.notice ? `<div class="notice"><p>${escapeHtml(input.notice)}</p></div>` : "";
  const links = input.email
    ? `<p>Signed in as ${escapeHtml(input.email)}.</p><div class="actions"><a class="button" href="/dashboard">Dashboard</a></div>`
    : `<div class="actions"><a class="button" href="/signup">Sign up</a><a class="button secondary" href="/login">Log in</a></div>`;
  return layout(
    "OpenMail: email for AI agents",
    `${notice}<div class="hero"><img src="/logo.svg" alt="OpenMail logo" width="96" height="96"><h1>OpenMail</h1></div>
<p class="lead">Let your AI agent read and search your email over IMAP, from any provider: Migadu, Fastmail, Zoho, iCloud, or your own server.</p>
${links}
<section><h2>How it works</h2>
<ol>
<li>Create an OpenMail account.</li>
<li>Add one or more mailboxes. OpenMail signs in once to check the details before saving them.</li>
<li>Create an API key and add OpenMail to your agent as an MCP server.</li>
</ol>
</section>
<section><h2>Privacy in short</h2>
<ul>
<li><strong>Read-only.</strong> Agents can list folders, search, and read messages. They cannot send, delete, move, or flag mail, and reading does not mark messages as read.</li>
<li><strong>No mail is stored.</strong> Messages are fetched from your provider when your agent asks and are not kept on OpenMail's servers.</li>
<li><strong>Passwords are encrypted.</strong> Mailbox passwords are encrypted with a key unique to your account and are never shown again, logged, or sent to the agent.</li>
</ul>
<p>Use an app-specific password where your provider offers one. Read the full <a href="/privacy">privacy policy</a>.</p>
</section>`,
    input.csrf ? { csrf: input.csrf } : {},
  );
}

export function privacyPage(options: { csrf?: string } = {}): string {
  return layout(
    "Privacy policy · OpenMail",
    `<h1>Privacy policy</h1>
<p class="muted">Last updated October 2026</p>
<p>OpenMail is a connector that lets AI agents read your email through the Model Context Protocol (MCP). This page explains what OpenMail keeps and what it does not.</p>
<h2>What we store</h2>
<ul>
<li>Your OpenMail login email and a one-way (Argon2id) hash of your password.</li>
<li>For each mailbox you add: a name, the mailbox address and username, the provider and server settings, and the mailbox password encrypted with AES-256-GCM using a key unique to your account.</li>
<li>API keys as one-way SHA-256 hashes, with a short prefix, name, and created and last-used times so you can tell them apart.</li>
<li>Session records for signed-in browsers, which expire after seven days.</li>
</ul>
<h2>What we do not store</h2>
<ul>
<li>Email messages, attachments, subjects, or contacts. They are fetched from your provider when your agent asks and passed straight back to it.</li>
<li>Plain-text passwords or API keys. They are never written to logs.</li>
</ul>
<h2>How your data is used</h2>
<p>Mailbox credentials are used only to sign in to your provider when you, or an agent holding one of your API keys, make a request. OpenMail does not sell, share, or analyse your data, and does not use it for advertising or for training models.</p>
<h2>Your agent</h2>
<p>Messages OpenMail returns go to the agent you connected. How that agent and its provider handle them is covered by their own policies.</p>
<h2>Security</h2>
<p>All traffic uses HTTPS. Access is read-only: OpenMail cannot send, delete, move, or flag mail. Revoke an API key or remove a mailbox from your dashboard at any time, and it stops working immediately.</p>
<h2>Deleting your data</h2>
<p>Removing a mailbox deletes its stored settings and encrypted password. To delete your whole account, email <a href="mailto:${SUPPORT_EMAIL}">${SUPPORT_EMAIL}</a> from your login address.</p>
<h2>Changes</h2>
<p>If this policy changes, the date above changes too. Material changes will be announced on this site.</p>
<h2>Contact</h2>
<p><a href="mailto:${SUPPORT_EMAIL}">${SUPPORT_EMAIL}</a></p>`,
    options,
  );
}

export function reviewersPage(guideHtml: string, options: { csrf?: string } = {}): string {
  return layout("Reviewer guide · OpenMail", `<article class="guide">${guideHtml}</article>`, options);
}

export function termsPage(options: { csrf?: string } = {}): string {
  return layout(
    "Terms of service · OpenMail",
    `<h1>Terms of service</h1>
<p class="muted">Last updated October 2026</p>
<p>By creating an OpenMail account or using an OpenMail API key you agree to these terms.</p>
<h2>The service</h2>
<p>OpenMail gives AI agents read-only access to mailboxes you connect, over the Model Context Protocol. It is provided "as is", without warranties of any kind, and may change or be unavailable at times.</p>
<h2>Your responsibilities</h2>
<ul>
<li>Only connect mailboxes you own or are authorised to access.</li>
<li>Keep your login password and API keys secret. Anyone holding one of your API keys can read the mailboxes on your account.</li>
<li>Do not use OpenMail to break the law, to break your mail provider's terms, to probe or attack other systems, or to overload the service.</li>
<li>You are responsible for what your agent does with the email it reads. Email content is untrusted data and should never be treated as instructions.</li>
</ul>
<h2>Limits</h2>
<p>Requests are rate limited. OpenMail may suspend accounts that abuse the service or put other users at risk.</p>
<h2>Liability</h2>
<p>To the extent the law allows, OpenMail is not liable for indirect or consequential losses, or for lost data, arising from use of the service.</p>
<h2>Ending use</h2>
<p>You can stop at any time by revoking your keys and removing your mailboxes, or by asking us to delete your account. We may end the service with reasonable notice.</p>
<h2>Contact</h2>
<p><a href="mailto:${SUPPORT_EMAIL}">${SUPPORT_EMAIL}</a></p>`,
    options,
  );
}

export function authPage(input: {
  mode: "signup" | "login";
  csrf: string;
  email?: string;
  errors?: string[];
}): string {
  const signup = input.mode === "signup";
  const title = signup ? "Sign up" : "Log in";
  const action = signup ? "/signup" : "/login";
  const button = signup ? "Create account" : "Log in";
  const other = signup
    ? `<p>Already have an account? <a href="/login">Log in</a></p>`
    : `<p>No account yet? <a href="/signup">Sign up</a></p>`;
  return layout(
    title,
    `${errorBlock(input.errors)}<h1>${title}</h1>
<form class="stack" method="post" action="${action}">
<input type="hidden" name="_csrf" value="${escapeHtml(input.csrf)}">
<label>Email <input name="email" type="email" autocomplete="username" maxlength="254" value="${escapeHtml(input.email ?? "")}" required></label>
<label>Password <input name="password" type="password" autocomplete="${signup ? "new-password" : "current-password"}" minlength="${signup ? "10" : "1"}" maxlength="200" required></label>
<button type="submit">${button}</button>
</form>
${other}`,
  );
}

export function dashboardPage(input: {
  email: string;
  csrf: string;
  accounts: MailAccountSummary[];
  keys: ApiKeySummary[];
  mcpUrl: string | null;
  draft: AccountDraft;
  errors?: string[];
  notice?: string;
  probeMessage?: string;
}): string {
  const alerts = `${input.notice ? `<div class="notice"><p>${escapeHtml(input.notice)}</p></div>` : ""}${
    input.probeMessage ? `<div class="notice"><p>${escapeHtml(input.probeMessage)}</p></div>` : ""
  }${errorBlock(input.errors)}`;
  return layout(
    "Dashboard",
    `${alerts}<h1>Dashboard</h1><p class="muted">Signed in as ${escapeHtml(input.email)}</p>
${accountList(input.accounts, input.csrf)}
${accountForm(input.draft, input.csrf)}
${keyList(input.keys, input.csrf)}
${keyForm(input.csrf)}
${grokSection(input.mcpUrl)}`,
    { csrf: input.csrf, script: true },
  );
}

export function keyRevealPage(input: { csrf: string; name: string; token: string; prefix: string }): string {
  return layout(
    "API key created",
    `<h1>API key created</h1>
<p>Copy this key now. OpenMail stores only a hash and will not show it again.</p>
<p><span class="muted">Name</span> ${escapeHtml(input.name)}</p>
<p><span class="muted">Prefix</span> <code>${escapeHtml(input.prefix)}</code></p>
<pre><code id="new-api-key">${escapeHtml(input.token)}</code></pre>
<p><span class="muted">Header</span></p>
<pre><code>Authorization: Bearer ${escapeHtml(input.token)}</code></pre>
<p><a class="button" href="/dashboard">Back to dashboard</a></p>`,
    { csrf: input.csrf },
  );
}

export function statusPage(title: string, text: string, statusHint?: string): string {
  return layout(title, `<h1>${escapeHtml(title)}</h1><p>${escapeHtml(text)}</p>${statusHint ? `<p class="muted">${escapeHtml(statusHint)}</p>` : ""}`);
}

function errorBlock(errors: string[] | undefined): string {
  if (!errors || errors.length === 0) return "";
  return `<div class="errors" role="alert"><ul>${errors.map((error) => `<li>${escapeHtml(error)}</li>`).join("")}</ul></div>`;
}

function accountList(accounts: MailAccountSummary[], csrf: string): string {
  if (accounts.length === 0) {
    return `<section id="account-list"><h2>Mail accounts</h2><p>No mail accounts yet.</p></section>`;
  }
  const items = accounts
    .map(
      (account) => `<li>
<p><span class="muted">Name</span> ${escapeHtml(account.name)}</p>
<p><span class="muted">Email</span> ${escapeHtml(account.email)}</p>
<p><span class="muted">Preset</span> ${escapeHtml(account.preset)}</p>
<p><span class="muted">Host</span> ${escapeHtml(account.imapHost)}</p>
<form method="post" action="/accounts/${escapeHtml(account.id)}/delete"><input type="hidden" name="_csrf" value="${escapeHtml(csrf)}"><button class="secondary" type="submit">Remove</button></form>
</li>`,
    )
    .join("");
  return `<section id="account-list"><h2>Mail accounts</h2><ul class="records">${items}</ul></section>`;
}

function accountForm(draft: AccountDraft, csrf: string): string {
  const custom = draft.preset === "custom";
  const locked = custom ? "" : " readonly";
  const checksDisabled = custom ? "" : " disabled";
  return `<section id="account-form"><h2>Add mailbox</h2>
<form class="stack" method="post" action="/accounts">
<input type="hidden" name="_csrf" value="${escapeHtml(csrf)}">
<label>Name <input id="account-name" name="name" maxlength="200" value="${escapeHtml(draft.name)}" required></label>
<label>Email <input id="account-email" name="email" type="email" maxlength="254" value="${escapeHtml(draft.email)}" required></label>
<label>Username <input id="username" name="username" maxlength="200" value="${escapeHtml(draft.username)}" placeholder="Defaults to the email address"></label>
<label>Password <input id="mailbox-password" name="password" type="password" maxlength="1000" autocomplete="off" required></label>
<label>Preset <select id="preset" name="preset">${PROVIDER_PRESETS.map((preset) => option(preset, preset, draft.preset === preset)).join("")}</select></label>
<label>Zoho region <select id="zoho_region" name="zoho_region"${draft.preset === "zoho" ? "" : " disabled"}>${ZOHO_REGIONS.map((region) => option(region, region, draft.zohoRegion === region)).join("")}</select></label>
<div class="grid-2">
<label>IMAP host <input id="imap_host" name="imap_host" value="${escapeHtml(draft.imapHost)}"${locked}></label>
<label>IMAP port <input id="imap_port" name="imap_port" inputmode="numeric" value="${escapeHtml(draft.imapPort)}"${locked}></label>
<label>SMTP host <input id="smtp_host" name="smtp_host" value="${escapeHtml(draft.smtpHost)}"${locked}></label>
<label>SMTP port <input id="smtp_port" name="smtp_port" inputmode="numeric" value="${escapeHtml(draft.smtpPort)}"${locked}></label>
</div>
<label class="check"><input id="imap_secure" name="imap_secure" type="checkbox" value="on"${draft.imapSecure ? " checked" : ""}${checksDisabled}> IMAP TLS</label>
<label class="check"><input id="smtp_secure" name="smtp_secure" type="checkbox" value="on"${draft.smtpSecure ? " checked" : ""}${checksDisabled}> SMTP implicit TLS</label>
<label class="check"><input id="smtp_starttls" name="smtp_starttls" type="checkbox" value="on"${draft.smtpStarttls ? " checked" : ""}${checksDisabled}> SMTP STARTTLS</label>
<div class="row"><button type="submit">Save</button><button class="secondary" type="submit" formaction="/accounts/test">Test connection</button></div>
</form>
</section>`;
}

function keyList(keys: ApiKeySummary[], csrf: string): string {
  if (keys.length === 0) return `<section id="key-list"><h2>API keys</h2><p>No API keys yet.</p></section>`;
  const items = keys
    .map((key) => {
      const status = key.revokedAt ? "revoked" : "active";
      const revoke = key.revokedAt
        ? ""
        : `<form method="post" action="/keys/${escapeHtml(key.id)}/revoke"><input type="hidden" name="_csrf" value="${escapeHtml(csrf)}"><button class="secondary" type="submit">Revoke</button></form>`;
      return `<li>
<p><span class="muted">Name</span> ${escapeHtml(key.name)}</p>
<p><span class="muted">Prefix</span> <code>${escapeHtml(key.prefix)}</code></p>
<p><span class="muted">Created</span> ${escapeHtml(key.createdAt)}</p>
<p><span class="muted">Last used</span> ${escapeHtml(key.lastUsedAt ?? "Never")}</p>
<p><span class="muted">Status</span> ${status}</p>
${revoke}
</li>`;
    })
    .join("");
  return `<section id="key-list"><h2>API keys</h2><ul class="records">${items}</ul></section>`;
}

function keyForm(csrf: string): string {
  return `<section id="key-form"><h2>Create API key</h2>
<form class="stack" method="post" action="/keys">
<input type="hidden" name="_csrf" value="${escapeHtml(csrf)}">
<label>Name <input id="key-name" name="name" maxlength="200" required></label>
<button type="submit">Create key</button>
</form>
</section>`;
}

function grokSection(mcpUrl: string | null): string {
  const url = mcpUrl ? escapeHtml(mcpUrl) : "Set OPENMAIL_PUBLIC_URL";
  return `<section id="grok"><h2>Connect to Grok Bot</h2>
<p>Create an API key above, then add OpenMail to Grok Bot as a custom MCP connector (streamable HTTP) with this URL and header. Tools: list_accounts, list_folders, search_messages, read_message, read_thread.</p>
<p><span class="muted">MCP URL</span> <code>${url}</code></p>
<p><span class="muted">Header</span> <code>${escapeHtml("Authorization: Bearer <your key>")}</code></p>
</section>`;
}

function option(value: string, label: string, selected: boolean): string {
  return `<option value="${escapeHtml(value)}"${selected ? " selected" : ""}>${escapeHtml(label)}</option>`;
}
