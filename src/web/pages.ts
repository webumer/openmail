import type { ApiKeySummary, MailAccountSummary } from "../services/index.js";
import { PROVIDER_PRESETS, ZOHO_REGIONS } from "../mail/presets.js";
import type { AccountDraft } from "./forms.js";
import { escapeHtml } from "./html.js";

export const SUPPORT_EMAIL = "support@openmail.tools";
export const SITE_URL = "https://mcp.openmail.tools";
export const MCP_ENDPOINT = `${SITE_URL}/mcp`;
const DEFAULT_DESCRIPTION =
  "Connect any IMAP email inbox to your AI assistant. Read-only, works with any provider, and no email content is stored.";

export interface LayoutOptions {
  csrf?: string;
  script?: boolean;
  description?: string;
  /** Landing page: full-width sections instead of the narrow page column. */
  landing?: boolean;
  path?: string;
}

const LOGO_MARK = `<svg class="mark" viewBox="0 0 512 512" width="32" height="32" aria-hidden="true" focusable="false"><rect width="512" height="512" rx="112" fill="#0E7C66"/><path d="M104 236 L256 116 L408 236 Z" fill="#8FE3C9" stroke="#8FE3C9" stroke-width="16" stroke-linejoin="round"/><rect x="96" y="220" width="320" height="196" rx="28" fill="#FFFFFF"/><path d="M128 252 L256 340 L384 252" fill="none" stroke="#0E7C66" stroke-width="26" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

export function layout(title: string, body: string, options: LayoutOptions = {}): string {
  const description = options.description ?? DEFAULT_DESCRIPTION;
  const url = `${SITE_URL}${options.path ?? "/"}`;
  const signedIn = options.csrf !== undefined;
  const account = signedIn
    ? `<a class="nav-link" href="/dashboard">Dashboard</a><form method="post" action="/logout"><input type="hidden" name="_csrf" value="${escapeHtml(options.csrf ?? "")}"><button class="btn btn-ghost" type="submit">Log out</button></form>`
    : `<a class="nav-link" href="/login">Log in</a><a class="btn btn-primary btn-sm" href="/signup">Get started</a>`;
  const sections = options.landing
    ? `<nav class="nav-sections" aria-label="Sections"><a class="nav-link" href="#how">How it works</a><a class="nav-link" href="#connect">Connect</a><a class="nav-link" href="#security">Security</a><a class="nav-link" href="#faq">FAQ</a></nav>`
    : "";
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<meta name="description" content="${escapeHtml(description)}">
<meta name="theme-color" content="#0E7C66">
<link rel="canonical" href="${escapeHtml(url)}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="OpenMail">
<meta property="og:title" content="${escapeHtml(title)}">
<meta property="og:description" content="${escapeHtml(description)}">
<meta property="og:url" content="${escapeHtml(url)}">
<meta property="og:image" content="${SITE_URL}/og.png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:alt" content="OpenMail: connect any email inbox to your AI assistant">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${escapeHtml(title)}">
<meta name="twitter:description" content="${escapeHtml(description)}">
<meta name="twitter:image" content="${SITE_URL}/og.png">
<link rel="icon" type="image/svg+xml" href="/logo.svg">
<link rel="icon" type="image/png" href="/logo.png">
<link rel="apple-touch-icon" href="/logo.png">
<link rel="stylesheet" href="/static/style.css">
</head>
<body${options.landing ? ' class="landing"' : ""}>
<a class="skip" href="#main">Skip to content</a>
<header class="site-header"><div class="container header-inner">
<a class="brand" href="/">${LOGO_MARK}<span>OpenMail</span></a>
${sections}
<div class="nav-account">${account}</div>
</div></header>
<main id="main"${options.landing ? "" : ' class="page"'}>
${body}
</main>
<footer class="site-footer"><div class="container footer-inner">
<div class="footer-brand"><a class="brand" href="/">${LOGO_MARK}<span>OpenMail</span></a><p>Email for AI assistants. Read-only, any IMAP provider.</p></div>
<nav class="footer-links" aria-label="Footer">
<a href="/privacy">Privacy</a><a href="/terms">Terms</a><a href="/reviewers">Reviewers</a><a href="https://github.com/webumer/openmail" rel="noopener">GitHub</a><a href="mailto:${SUPPORT_EMAIL}">${SUPPORT_EMAIL}</a>
</nav>
<p class="copyright">© 2026 OpenMail</p>
</div></footer>
<script src="/static/site.js"></script>
${options.script ? '<script src="/static/app.js"></script>' : ""}
</body>
</html>`;
}

function icon(name: "user" | "inbox" | "key" | "shield" | "eye" | "lock" | "check" | "code" | "server" | "chat"): string {
  const paths: Record<string, string> = {
    user: '<circle cx="12" cy="8" r="4"/><path d="M4 20c0-4 4-6 8-6s8 2 8 6"/>',
    inbox: '<path d="M3 13l3-8h12l3 8v6H3z"/><path d="M3 13h5l1 3h6l1-3h5"/>',
    key: '<circle cx="8" cy="15" r="4"/><path d="M11 12l9-9M16 7l3 3M14 9l2 2"/>',
    shield: '<path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z"/><path d="M9 12l2 2 4-4"/>',
    eye: '<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
    lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 018 0v4"/>',
    check: '<path d="M5 12l5 5 9-10"/>',
    code: '<path d="M8 8l-4 4 4 4M16 8l4 4-4 4M14 5l-4 14"/>',
    server: '<rect x="3" y="4" width="18" height="7" rx="2"/><rect x="3" y="13" width="18" height="7" rx="2"/><path d="M7 7.5h.01M7 16.5h.01"/>',
    chat: '<path d="M4 5h16v11H9l-5 4z"/>',
  };
  return `<svg class="icon" viewBox="0 0 24 24" width="24" height="24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${paths[name] ?? ""}</svg>`;
}

function copyField(label: string, value: string, id: string): string {
  return `<div class="copy-field"><span class="copy-label" id="${id}-label">${escapeHtml(label)}</span><div class="copy-row"><code id="${id}">${escapeHtml(value)}</code><button class="btn btn-copy" type="button" data-copy="${id}" aria-describedby="${id}-label">Copy</button></div></div>`;
}

export function homePage(input: { email: string | null; csrf?: string; notice?: string }): string {
  const notice = input.notice ? `<div class="container"><div class="notice" role="status"><p>${escapeHtml(input.notice)}</p></div></div>` : "";
  const primary = input.email
    ? `<a class="btn btn-primary btn-lg" href="/dashboard">Open dashboard</a>`
    : `<a class="btn btn-primary btn-lg" href="/signup">Get started free</a>`;
  const tools: Array<[string, string]> = [
    ["list_accounts", "Lists the mailboxes you added: name, address, provider and host. Never passwords."],
    ["list_folders", "Folders with total and unread counts."],
    ["search_messages", "Search by sender, recipient, subject, text, date, unread or attachments. Newest first, paged."],
    ["read_message", "Headers, plain-text body and attachment names and sizes. Does not mark the message as read."],
    ["read_thread", "The whole conversation, oldest first."],
  ];
  const security: Array<[Parameters<typeof icon>[0], string, string]> = [
    ["eye", "Read-only", "Agents can list, search and read. They cannot send, delete, move or flag mail."],
    ["check", "Never marks mail as read", "Messages are opened read-only and fetched with BODY.PEEK, so unread stays unread."],
    ["server", "No email stored", "Messages are fetched from your provider on request and passed straight to your assistant."],
    ["lock", "Encrypted passwords", "Mailbox passwords are encrypted with AES-256-GCM using a key unique to your account."],
    ["key", "Hashed, revocable keys", "API keys are stored only as SHA-256 hashes. Revoke one and it stops working at once."],
    ["shield", "TLS always verified", "Connections to mail servers use TLS with certificate checks that cannot be switched off."],
    ["chat", "Email is untrusted content", "Tool results tell the assistant that email text is data, never instructions to follow."],
    ["code", "MIT licensed", "OpenMail is MIT-licensed software. The source code is <a href=\"https://github.com/webumer/openmail\" rel=\"noopener\">on GitHub</a>."],
  ];
  const faq: Array<[string, string]> = [
    ["Is my mail stored?", "No. OpenMail fetches messages from your provider when your assistant asks and does not keep them. It stores only your account details, encrypted mailbox passwords and hashed API keys. See the <a href=\"/privacy\">privacy policy</a>."],
    ["Can it send or delete email?", "No. Today OpenMail is read-only: no sending, deleting, moving or flagging. Sending is planned, as drafts that go out only after you approve them."],
    ["Which providers work?", "Any mailbox with IMAP access. Migadu, Fastmail, Zoho and iCloud have presets; for anything else, enter your IMAP server with TLS on port 993 (or STARTTLS on 143). Use an app-specific password where your provider offers one."],
    ["How do I revoke access?", "Open your dashboard and revoke the API key, or remove the mailbox. Both take effect immediately."],
    ["Is it free?", "Yes, OpenMail is free while in beta."],
    ["Can I self-host?", "Yes, OpenMail runs as a single Docker Compose stack. See the <a href=\"https://github.com/webumer/openmail/blob/main/docs/deploy.md\" rel=\"noopener\">deploy guide on GitHub</a>."],
  ];
  return layout(
    "OpenMail: connect any email inbox to your AI assistant",
    `${notice}
<section class="hero"><div class="container hero-inner">
<div class="hero-copy">
<p class="eyebrow">Email for AI assistants</p>
<h1>Connect any email inbox to your AI assistant</h1>
<p class="lead">Works with any IMAP provider. Read-only, and nothing is stored: your assistant searches and reads your mail live, over a secure MCP connection.</p>
<div class="cta">${primary}<a class="btn btn-secondary btn-lg" href="#how">How it works</a></div>
<ul class="hero-points" aria-label="Highlights"><li>${icon("check")}Any IMAP provider</li><li>${icon("check")}Read-only</li><li>${icon("check")}No email stored</li></ul>
</div>
<div class="hero-art" aria-hidden="true">
<div class="mock">
<div class="mock-bar"><span></span><span></span><span></span></div>
<div class="mock-body">
<p class="bubble bubble-user">Summarize unread emails from today</p>
<p class="bubble bubble-tool"><span class="tool-chip">search_messages</span> unread, since today · 4 results</p>
<p class="bubble bubble-bot">You have 4 unread emails: a delivery update, a meetup reminder, a reply about the Q4 offsite, and a sale newsletter.</p>
</div></div>
<img class="hero-logo" src="/logo.svg" alt="" width="120" height="120">
</div>
</div></section>

<section id="how" class="section"><div class="container">
<h2 class="section-title">How it works</h2>
<p class="section-lead">Three steps, about two minutes.</p>
<ol class="steps">
<li class="card step">${icon("user")}<h3>Create an account</h3><p>Sign up with an email and password. No credit card.</p></li>
<li class="card step">${icon("inbox")}<h3>Add your mailboxes</h3><p>Pick a preset or enter any IMAP server. OpenMail tests the connection before saving, then encrypts the password.</p></li>
<li class="card step">${icon("key")}<h3>Connect Grok Bot</h3><p>Create an API key in your dashboard and add OpenMail as a connector in Grok Bot.</p></li>
</ol>
</div></section>

<section id="connect" class="section section-tint"><div class="container narrow">
<h2 class="section-title">Connect to Grok Bot</h2>
<ol class="guide-steps">
<li><a href="/signup">Sign up</a>, add a mailbox, then create an API key on your dashboard. Copy it: it is shown only once.</li>
<li>In Grok Bot, install OpenMail from the connector list, or add a custom MCP connector (streamable HTTP) with:</li>
</ol>
<div class="copy-block">
${copyField("MCP URL", MCP_ENDPOINT, "copy-url")}
${copyField("Header", "Authorization: Bearer <your key>", "copy-header")}
</div>
<ol class="guide-steps" start="3"><li>Ask Grok Bot something about your email. Revoke the key any time from your dashboard.</li></ol>
</div></section>

<section id="ask" class="section"><div class="container">
<h2 class="section-title">What you can ask</h2>
<p class="section-lead">Ask Grok Bot in plain language. It picks the right tools.</p>
<ul class="prompts">
<li class="card prompt">${icon("chat")}<span>“Find invoices from last month”</span></li>
<li class="card prompt">${icon("chat")}<span>“Summarize unread emails from today”</span></li>
<li class="card prompt">${icon("chat")}<span>“Show the thread with Acme about the contract”</span></li>
</ul>
</div></section>

<section id="tools" class="section section-tint"><div class="container">
<h2 class="section-title">Tools</h2>
<p class="section-lead">Five read-only MCP tools.</p>
<div class="tools">${tools.map(([name, text]) => `<div class="card tool"><code>${name}</code><p>${text}</p></div>`).join("")}</div>
</div></section>

<section id="security" class="section"><div class="container">
<h2 class="section-title">Security &amp; privacy</h2>
<p class="section-lead">Built to be safe to connect to an inbox.</p>
<ul class="features">${security.map(([i, title, text]) => `<li class="feature">${icon(i)}<div><h3>${title}</h3><p>${text}</p></div></li>`).join("")}</ul>
</div></section>

<section id="providers" class="section section-tint"><div class="container">
<h2 class="section-title">Works with</h2>
<ul class="badges" aria-label="Supported providers"><li>Migadu</li><li>Fastmail</li><li>Zoho Mail</li><li>iCloud Mail</li><li>Any IMAP server</li></ul>
</div></section>

<section id="faq" class="section"><div class="container narrow">
<h2 class="section-title">FAQ</h2>
<div class="faq">${faq.map(([q, a]) => `<details><summary>${q}</summary><p>${a}</p></details>`).join("")}</div>
</div></section>

<section class="section cta-band"><div class="container cta-band-inner">
<h2>Give your assistant your inbox, safely</h2>
<div class="cta">${primary}<a class="btn btn-secondary btn-lg" href="/reviewers">Reviewer guide</a></div>
</div></section>`,
    { ...(input.csrf ? { csrf: input.csrf } : {}), landing: true, path: "/" },
  );
}

export function privacyPage(options: { csrf?: string } = {}): string {
  return layout(
    "Privacy policy · OpenMail",
    `<article class="prose"><h1>Privacy policy</h1>
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
<p><a href="mailto:${SUPPORT_EMAIL}">${SUPPORT_EMAIL}</a></p></article>`,
    { ...options, path: "/privacy", description: "What OpenMail stores, what it does not, and how your mailbox credentials are protected." },
  );
}

export function reviewersPage(guideHtml: string, options: { csrf?: string } = {}): string {
  return layout("Reviewer guide · OpenMail", `<article class="prose guide">${guideHtml}</article>`, {
    ...options,
    path: "/reviewers",
    description: "How marketplace reviewers can test the OpenMail connector.",
  });
}

export function termsPage(options: { csrf?: string } = {}): string {
  return layout(
    "Terms of service · OpenMail",
    `<article class="prose"><h1>Terms of service</h1>
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
<p><a href="mailto:${SUPPORT_EMAIL}">${SUPPORT_EMAIL}</a></p></article>`,
    { ...options, path: "/terms", description: "The terms for using OpenMail." },
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
  const intro = signup
    ? "Create a free account, then add a mailbox and an API key."
    : "Welcome back. Log in to manage your mailboxes and keys.";
  return layout(
    `${title} · OpenMail`,
    `<div class="auth"><div class="card auth-card">
<a class="auth-logo" href="/"><img src="/logo.svg" alt="OpenMail" width="56" height="56"></a>
<h1>${title}</h1><p class="muted">${intro}</p>
${errorBlock(input.errors)}
<form class="stack" method="post" action="${action}">
<input type="hidden" name="_csrf" value="${escapeHtml(input.csrf)}">
<label>Email <input name="email" type="email" autocomplete="username" maxlength="254" value="${escapeHtml(input.email ?? "")}" required></label>
<label>Password <input name="password" type="password" autocomplete="${signup ? "new-password" : "current-password"}" minlength="${signup ? "10" : "1"}" maxlength="200" required></label>
<button class="btn btn-primary btn-block" type="submit">${button}</button>
</form>
<div class="auth-other">${other}</div>
${signup ? '<p class="fine">By signing up you agree to the <a href="/terms">terms</a> and <a href="/privacy">privacy policy</a>.</p>' : ""}
</div></div>`,
    { path: action, description: signup ? "Create a free OpenMail account." : "Log in to OpenMail." },
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
    "Dashboard · OpenMail",
    `<div class="dash-head"><div><h1>Dashboard</h1><p class="muted">Signed in as ${escapeHtml(input.email)}</p></div></div>
${alerts}
<div class="dash-grid">
<div class="card">${accountList(input.accounts, input.csrf)}</div>
<div class="card">${accountForm(input.draft, input.csrf)}</div>
<div class="card">${keyList(input.keys, input.csrf)}${keyForm(input.csrf)}</div>
<div class="card">${grokSection(input.mcpUrl)}</div>
</div>`,
    { csrf: input.csrf, script: true, path: "/dashboard" },
  );
}

export function keyRevealPage(input: { csrf: string; name: string; token: string; prefix: string }): string {
  return layout(
    "API key created · OpenMail",
    `<div class="card reveal">
<h1>API key created</h1>
<div class="notice warn" role="status"><p>Copy this key now. OpenMail stores only a hash and will not show it again.</p></div>
<p><span class="muted">Name</span> ${escapeHtml(input.name)} · <span class="muted">Prefix</span> <code>${escapeHtml(input.prefix)}</code></p>
${copyField("API key", input.token, "new-api-key")}
${copyField("Header", `Authorization: Bearer ${input.token}`, "new-api-header")}
${copyField("MCP URL", MCP_ENDPOINT, "new-api-url")}
<p><a class="btn btn-primary" href="/dashboard">Back to dashboard</a></p>
</div>`,
    { csrf: input.csrf },
  );
}

export function statusPage(title: string, text: string, statusHint?: string): string {
  return layout(
    `${title} · OpenMail`,
    `<div class="card status"><h1>${escapeHtml(title)}</h1><p>${escapeHtml(text)}</p>${statusHint ? `<p class="muted">${escapeHtml(statusHint)}</p>` : ""}<p><a class="btn btn-secondary" href="/">Home</a></p></div>`,
  );
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
  const url = mcpUrl ?? "Set OPENMAIL_PUBLIC_URL";
  return `<section id="grok"><h2>Connect to Grok Bot</h2>
<p>Create an API key above, then add OpenMail to Grok Bot as a custom MCP connector (streamable HTTP) with this URL and header. Tools: list_accounts, list_folders, search_messages, read_message, read_thread.</p>
${copyField("MCP URL", url, "dash-url")}
${copyField("Header", "Authorization: Bearer <your key>", "dash-header")}
</section>`;
}

function option(value: string, label: string, selected: boolean): string {
  return `<option value="${escapeHtml(value)}"${selected ? " selected" : ""}>${escapeHtml(label)}</option>`;
}
