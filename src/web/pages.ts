import type { ApiKeySummary, MailAccountSummary } from "../services/index.js";
import type { SendLogRow } from "../services/send-log.js";
import type { GrantSummary } from "../oauth/grants.js";
import { PROVIDER_PRESETS, ZOHO_REGIONS } from "../mail/presets.js";
import type { AccountDraft } from "./forms.js";
import { escapeHtml } from "./html.js";

export const SUPPORT_EMAIL = "support@openmail.tools";
export const SITE_URL = "https://mcp.openmail.tools";
export const MCP_ENDPOINT = `${SITE_URL}/mcp`;
const DEFAULT_DESCRIPTION =
  "Connect any email inbox to your AI assistant. Read-only by default. Sending is opt-in per mailbox, and your assistant asks you before every email.";

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
<a href="/privacy">Privacy</a><a href="/terms">Terms</a><a href="/support">Support</a><a href="/reviewers">Reviewers</a><a href="https://github.com/webumer/openmail" rel="noopener">GitHub</a><a href="mailto:${SUPPORT_EMAIL}">${SUPPORT_EMAIL}</a>
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
    ["send_message", "Sends one email after you have seen it and said to send it. Off unless you turn sending on for that mailbox."],
  ];
  const security: Array<[Parameters<typeof icon>[0], string, string]> = [
    ["eye", "Read-only by default", "Agents can list, search and read. Sending is off until you turn it on for a mailbox and allow it for that connection. They cannot delete, move or flag mail."],
    ["check", "Never marks mail as read", "Messages are opened read-only and fetched with BODY.PEEK, so unread stays unread."],
    ["server", "No email stored", "Messages are fetched from your provider on request and passed straight to your assistant."],
    ["lock", "Encrypted passwords", "Mailbox passwords are encrypted with AES-256-GCM using a key unique to your account."],
    ["key", "Hashed, revocable access", "API keys and sign-in tokens are stored only as SHA-256 hashes. Revoke a key or disconnect an app and it stops working at once."],
    ["shield", "TLS always verified", "Connections to mail servers use TLS with certificate checks that cannot be switched off."],
    ["chat", "Email is untrusted content", "Tool results tell the assistant that email text is data, never instructions to follow."],
    ["code", "MIT licensed", "OpenMail is MIT-licensed software. The source code is <a href=\"https://github.com/webumer/openmail\" rel=\"noopener\">on GitHub</a>."],
  ];
  const faq: Array<[string, string]> = [
    ["Is my mail stored?", "No. OpenMail fetches messages from your provider when your assistant asks and does not keep them. It stores only your account details, encrypted mailbox passwords, and hashed API keys and sign-in tokens. See the <a href=\"/privacy\">privacy policy</a>."],
    ["Can it send or delete email?", "It can send only from a mailbox where you turned sending on, and only after your assistant shows you the email and you confirm it. It cannot delete, move or flag mail, and reading never marks a message as read."],
    ["Which providers work?", "Any mailbox with IMAP and SMTP. Migadu, Fastmail, Zoho, iCloud and Gmail have presets; for anything else, enter the servers yourself. Use an app-specific password where your provider offers one. Gmail needs an App Password."],
    ["Which assistants can I use?", "Any assistant that supports remote MCP servers. Clients that support MCP sign-in (OAuth), such as Claude custom connectors, Claude Code, ChatGPT and MCP Inspector, only need the URL: you log in to OpenMail and approve read-only access. Grok Bot and clients that send a fixed header use an API key from your dashboard."],
    ["How do I revoke access?", "Open your dashboard and disconnect the app under Connected apps, revoke the API key, or remove the mailbox. Each takes effect immediately."],
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
<p class="lead">Read-only by default. Sending is opt-in per mailbox, and your assistant asks you before every email.</p>
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
<li class="card step">${icon("key")}<h3>Connect your assistant</h3><p>Add the OpenMail URL and sign in to approve read-only access, or use an API key for Grok Bot.</p></li>
</ol>
</div></section>

<section id="connect" class="section section-tint"><div class="container narrow">
<h2 class="section-title">Connect your assistant</h2>
<p class="section-lead">First <a href="/signup">sign up</a> and add a mailbox. Then pick the option your assistant supports.</p>
<h3>Option 1: Sign in with OpenMail (Claude, ChatGPT and other MCP clients with sign-in)</h3>
<ol class="guide-steps">
<li>In your assistant, add a custom or remote MCP connector with just this URL. No key or header needed.</li>
</ol>
<div class="copy-block">
${copyField("MCP URL", MCP_ENDPOINT, "copy-oauth-url")}
</div>
<ol class="guide-steps" start="2">
<li>Your assistant opens OpenMail. Log in, check the list of mailboxes, and click <strong>Allow</strong> to grant read-only access.</li>
<li>Disconnect it any time under <strong>Connected apps</strong> on your dashboard.</li>
</ol>
<h3>Option 2: API key (Grok Bot and clients that send a header)</h3>
<ol class="guide-steps">
<li>Create an API key on your dashboard. Copy it: it is shown only once.</li>
<li>In Grok Bot, add a custom MCP connector (streamable HTTP) with:</li>
</ol>
<div class="copy-block">
${copyField("MCP URL", MCP_ENDPOINT, "copy-url")}
${copyField("Header", "Authorization: Bearer <your key>", "copy-header")}
</div>
<ol class="guide-steps" start="3"><li>Ask something about your email. Revoke the key any time from your dashboard.</li></ol>
</div></section>

<section id="ask" class="section"><div class="container">
<h2 class="section-title">What you can ask</h2>
<p class="section-lead">Ask your assistant in plain language. It picks the right tools.</p>
<ul class="prompts">
<li class="card prompt">${icon("chat")}<span>“Find invoices from last month”</span></li>
<li class="card prompt">${icon("chat")}<span>“Summarize unread emails from today”</span></li>
<li class="card prompt">${icon("chat")}<span>“Show the thread with Acme about the contract”</span></li>
</ul>
</div></section>

<section id="tools" class="section section-tint"><div class="container">
<h2 class="section-title">Tools</h2>
<p class="section-lead">Five read tools, plus send when you turn it on.</p>
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
<li>For apps you connect with “Sign in with OpenMail” (OAuth): the app's name, its redirect address and, if it identifies itself with a public metadata document, a cached copy of that document; plus the connection (when you approved it and last used it) and its access and refresh tokens as one-way SHA-256 hashes.</li>
</ul>
<h2>What we do not store</h2>
<ul>
<li>Email messages, attachments, subjects, or contacts. They are fetched from your provider when your agent asks and passed straight back to it.</li>
<li>Plain-text passwords, API keys or OAuth tokens. They are never written to logs.</li>
</ul>
<h2>What OpenMail returns to your assistant</h2>
<p>When an assistant you connected calls OpenMail, it can receive:</p>
<ul>
<li>For each mailbox: its name, address, provider preset, IMAP server name and an internal account ID.</li>
<li>For each message: sender and recipient names and addresses, subject, date, message ID, read and flag status, size, the message text, and attachment names, types and sizes. Attachment files themselves are never returned.</li>
<li>Folder names with message and unread counts.</li>
</ul>
<p>Nothing else about you is returned. Mailbox passwords and your OpenMail password are never returned.</p>
<h2>How your data is used</h2>
<p>Mailbox credentials are used only to sign in to your provider when you, or an agent holding one of your API keys or an app you approved, make a request. OpenMail does not sell, share, or analyse your data, and does not use it for advertising, profiling or training models.</p>
<h2>Your agent</h2>
<p>Messages OpenMail returns go to the agent you connected. How that agent and its provider handle them is covered by their own policies.</p>
<h2>Where your data is stored and who helps us run OpenMail</h2>
<p>OpenMail runs on a server rented from Contabo GmbH in the European Union. These providers handle limited data for us:</p>
<ul>
<li>Contabo GmbH: server hosting, where the database and logs are kept.</li>
<li>Cloudflare: DNS for openmail.tools, and forwarding of mail sent to ${SUPPORT_EMAIL}. Traffic to the service itself does not pass through Cloudflare.</li>
<li>Google (Gmail): the inbox where support email is read.</li>
<li>Let's Encrypt: HTTPS certificates. It receives no user data.</li>
</ul>
<p>Your mail provider is the one you choose. OpenMail connects to it only on your behalf.</p>
<h2>How long we keep data</h2>
<ul>
<li>Email content: not kept. It is held in memory only while a request is answered.</li>
<li>Account and mailbox settings, including an optional separate SMTP password encrypted with its own key binding: until you remove the mailbox or your account is deleted.</li>
<li>Send log: time, mailbox label, recipient count, status, message id and which connection sent it. No message body, subject or addresses. Kept for 90 days.</li>
<li>Signed-in browser sessions: 7 days. OAuth access tokens: 1 hour. OAuth refresh tokens: 30 days. API keys: until you revoke them.</li>
<li>Web server access logs (IP address, time, address requested, browser type and response status; never passwords, tokens or cookies): 14 days, then deleted automatically.</li>
</ul>
<h2>Security</h2>
<p>All traffic uses HTTPS. Reading never marks mail as read. Sending is off until you turn it on for a mailbox and allow it for that connection. OpenMail cannot delete, move or flag mail. Revoke an API key, disconnect an app, turn sending off or remove a mailbox from your dashboard at any time, and it stops working immediately.</p>
<h2>Deleting your data</h2>
<p>Removing a mailbox in your dashboard immediately deletes its stored settings and encrypted password. To delete your whole account, email <a href="mailto:${SUPPORT_EMAIL}">${SUPPORT_EMAIL}</a> from your login address. We delete it within 30 days, usually much sooner. Deletion removes your login, sessions, API keys, connected apps and every mailbox with its encrypted password from the database at once. OpenMail keeps no other copies.</p>
<h2>Requests from authorities</h2>
<p>We disclose data only when legally required, share only the minimum needed, and tell the affected user unless we are not allowed to.</p>
<h2>Changes</h2>
<p>If this policy changes, the date above changes too. Material changes will be announced on this site.</p>
<h2>Contact</h2>
<p><a href="mailto:${SUPPORT_EMAIL}">${SUPPORT_EMAIL}</a></p></article>`,
    { ...options, path: "/privacy", description: "What OpenMail stores, what it does not, and how your mailbox credentials are protected." },
  );
}

export function supportPage(options: { csrf?: string } = {}): string {
  return layout(
    "Support · OpenMail",
    `<article class="prose"><h1>Support</h1>
<p>OpenMail is an independent open-source project. For help, email <a href="mailto:${SUPPORT_EMAIL}">${SUPPORT_EMAIL}</a>. Please write from your OpenMail login address if your question is about your account. For bugs and feature requests, open an issue on <a href="https://github.com/webumer/openmail/issues" rel="noopener">GitHub</a>.</p>
<p>Found a security problem? Please don't open a public issue. Follow <a href="https://github.com/webumer/openmail/blob/main/SECURITY.md" rel="noopener">SECURITY.md</a> or email ${SUPPORT_EMAIL}.</p>
<h2>Frequently asked questions</h2>
<h3>How do I connect my assistant?</h3>
<p>Sign up, add a mailbox on your <a href="/dashboard">dashboard</a>, then add <code>https://mcp.openmail.tools/mcp</code> to your assistant. Assistants that support MCP sign-in (OAuth), such as Claude and ChatGPT, send you to OpenMail to log in and approve read-only access. Assistants that need a fixed header, such as Grok Bot, use an API key from your dashboard.</p>
<h3>My mailbox won't connect</h3>
<p>Most providers need IMAP turned on and an <strong>app password</strong> instead of your normal password, especially when two-step sign-in is on. The server must be reachable on the internet over TLS, usually port 993. Use <em>Test connection</em> before saving. OpenMail shows a short reason when sign-in fails.</p>
<h3>Will my assistant mark emails as read, or send or delete anything?</h3>
<p>Reading never marks mail as read. Sending happens only for a mailbox where you turned it on, through a connection allowed to send, and only when you confirm that message. There are no delete, move or flag tools.</p>
<h3>Does OpenMail store my email?</h3>
<p>No. Messages are fetched from your provider when you ask and passed straight to your assistant. See the <a href="/privacy">privacy policy</a> for exactly what is stored and for how long.</p>
<h3>How do I disconnect an assistant?</h3>
<p>On your dashboard, revoke its API key or click <em>Disconnect</em> under Connected apps. It stops working immediately.</p>
<h3>How do I delete my account?</h3>
<p>Email ${SUPPORT_EMAIL} from your login address. We delete the account within 30 days, usually much sooner. You can remove any mailbox yourself at any time.</p>
<h3>Which tools are available?</h3>
<p>list_accounts, list_folders, search_messages, read_message, read_thread and send_message. Inputs, outputs, errors and limits are documented in <a href="https://github.com/webumer/openmail/blob/main/docs/tools.md" rel="noopener">docs/tools.md</a>.</p>
</article>`,
    { ...options, path: "/support", description: "Get help with OpenMail: contact, GitHub issues and frequently asked questions." },
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
<p>OpenMail gives AI agents access to mailboxes you connect, over the Model Context Protocol. Sending is off unless you turn it on. It is provided "as is", without warranties of any kind, and may change or be unavailable at times.</p>
<h2>Your responsibilities</h2>
<ul>
<li>Only connect mailboxes you own or are authorised to access.</li>
<li>Keep your login password and API keys secret. Anyone holding one of your API keys can read the mailboxes on your account.</li>
<li>Do not use OpenMail to break the law, to break your mail provider's terms, to probe or attack other systems, or to overload the service.</li>
<li>You are responsible for mail you approve. Do not send spam. Sending is rate limited.</li>
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
  /** Validated same-site path to continue to after sign-in (OAuth authorize). */
  next?: string;
}): string {
  const signup = input.mode === "signup";
  const title = signup ? "Sign up" : "Log in";
  const action = signup ? "/signup" : "/login";
  const button = signup ? "Create account" : "Log in";
  const nextQuery = input.next ? `?next=${encodeURIComponent(input.next)}` : "";
  const other = signup
    ? `<p>Already have an account? <a href="/login${escapeHtml(nextQuery)}">Log in</a></p>`
    : `<p>No account yet? <a href="/signup${escapeHtml(nextQuery)}">Sign up</a></p>`;
  const intro = input.next
    ? signup
      ? "Create a free OpenMail account to connect your assistant. You can add a mailbox right after."
      : "Log in to OpenMail to connect your assistant."
    : signup
      ? "Create a free account, then add a mailbox and connect your assistant."
      : "Welcome back. Log in to manage your mailboxes, keys and connected apps.";
  const nextField = input.next ? `\n<input type="hidden" name="next" value="${escapeHtml(input.next)}">` : "";
  return layout(
    `${title} · OpenMail`,
    `<div class="auth"><div class="card auth-card">
<a class="auth-logo" href="/"><img src="/logo.svg" alt="OpenMail" width="56" height="56"></a>
<h1>${title}</h1><p class="muted">${intro}</p>
${errorBlock(input.errors)}
<form class="stack" method="post" action="${action}">
<input type="hidden" name="_csrf" value="${escapeHtml(input.csrf)}">${nextField}
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
  grants?: GrantSummary[];
  sends?: SendLogRow[];
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
<div class="card">${grantList(input.grants ?? [], input.csrf)}</div>
<div class="card">${oauthSection(input.mcpUrl)}</div>
<div class="card">${keyList(input.keys, input.csrf)}${keyForm(input.csrf)}</div>
<div class="card">${sendLogSection(input.sends ?? [])}</div>
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

/** Hands the browser back to the OAuth client after consent (see returnToClient). */
export function returnToClientPage(href: string): string {
  const safe = escapeHtml(href);
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<meta http-equiv="refresh" content="0; url='${safe}'">
<title>Returning to the app · OpenMail</title><link rel="stylesheet" href="/static/style.css"></head>
<body><main class="container"><div class="card status"><h1>Returning to the app…</h1>
<p>If nothing happens, <a id="return-link" href="${safe}">continue to the app</a>.</p></div></main></body></html>`;
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
<p><span class="muted">SMTP</span> ${escapeHtml(account.smtpHost)}:${account.smtpPort} · ${escapeHtml(smtpSecurityLabel(account))}</p>
<p><span class="muted">Sending</span> ${account.sendEnabled ? "On" : "Off"}</p>
<form method="post" action="/accounts/${escapeHtml(account.id)}/sending"><input type="hidden" name="_csrf" value="${escapeHtml(csrf)}"><input type="hidden" name="enabled" value="${account.sendEnabled ? "0" : "1"}"><button class="secondary" type="submit">${account.sendEnabled ? "Turn off sending" : "Allow sending"}</button></form>
<form method="post" action="/accounts/${escapeHtml(account.id)}/delete"><input type="hidden" name="_csrf" value="${escapeHtml(csrf)}"><button class="secondary" type="submit">Remove</button></form>
</li>`,
    )
    .join("");
  return `<section id="account-list"><h2>Mail accounts</h2><ul class="records">${items}</ul></section>`;
}

function smtpSecurityLabel(account: MailAccountSummary): string {
  if (account.smtpPort === 465 || account.smtpSecure) return "SSL/TLS";
  if (account.smtpPort === 587 || account.smtpPort === 2525 || account.smtpStarttls) return "STARTTLS";
  return "plain";
}

function sendLogSection(rows: SendLogRow[]): string {
  if (rows.length === 0) {
    return `<section id="send-log"><h2>Sent by your assistants</h2><p>Nothing has been sent yet.</p></section>`;
  }
  const items = rows
    .map(
      (row) => `<li>
<p><span class="muted">Time (UTC)</span> ${escapeHtml(row.createdAt)}</p>
<p><span class="muted">Mailbox</span> ${escapeHtml(row.accountLabel)}</p>
<p><span class="muted">Recipients</span> ${row.recipients}</p>
<p><span class="muted">Status</span> ${escapeHtml(row.errorCode === "in_progress" ? "in progress" : row.status)}</p>
<p><span class="muted">Message id</span> ${escapeHtml(row.messageId ?? "—")}</p>
<p><span class="muted">Via</span> ${escapeHtml(row.via)}</p>
</li>`,
    )
    .join("");
  return `<section id="send-log"><h2>Sent by your assistants</h2><ul class="records">${items}</ul></section>`;
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
<label>SMTP security <select id="smtp_security" name="smtp_security"${checksDisabled}>${option("tls", "SSL/TLS (465)", draft.smtpSecure && !draft.smtpStarttls)}${option("starttls", "STARTTLS (587)", draft.smtpStarttls)}</select></label>
<label>SMTP username <input id="smtp_username" name="smtp_username" maxlength="200" value="${escapeHtml(draft.smtpUsername)}" placeholder="Leave blank to use the IMAP login" autocomplete="off"></label>
<label>SMTP password <input id="smtp_password" name="smtp_password" type="password" maxlength="1000" autocomplete="off" placeholder="Only if the SMTP login is different"></label>
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
<p><span class="muted">Permission</span> ${key.canSend ? "Read and send" : "Read only"}</p>
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
<fieldset>
<legend>Permission</legend>
<label class="check"><input name="permission" type="radio" value="read" checked> Read only</label>
<label class="check"><input name="permission" type="radio" value="send"> Read and send</label>
</fieldset>
<button type="submit">Create key</button>
</form>
</section>`;
}

function grokSection(mcpUrl: string | null): string {
  const url = mcpUrl ?? "Set OPENMAIL_PUBLIC_URL";
  return `<section id="grok"><h2>Connect to Grok Bot</h2>
<p>Create an API key above, then add OpenMail to Grok Bot as a custom MCP connector (streamable HTTP) with this URL and header. A read-only key cannot send. Tools: list_accounts, list_folders, search_messages, read_message, read_thread, send_message.</p>
${copyField("MCP URL", url, "dash-url")}
${copyField("Header", "Authorization: Bearer <your key>", "dash-header")}
</section>`;
}

function grantList(grants: GrantSummary[], csrf: string): string {
  const intro = `<p class="muted">Apps you connected with “Sign in with OpenMail” (OAuth), such as Claude or ChatGPT. Disconnecting one stops it at once.</p>`;
  if (grants.length === 0) {
    return `<section id="connected-apps"><h2>Connected apps</h2>${intro}<p>No connected apps yet.</p></section>`;
  }
  const items = grants
    .map((grant) => {
      const verified = grant.clientKind === "cimd" && grant.clientHost
        ? `<p><span class="muted">Verified domain</span> ${escapeHtml(grant.clientHost)}</p>`
        : `<p><span class="muted">Identity</span> name supplied by the app</p>`;
      return `<li>
<p><span class="muted">App</span> ${escapeHtml(grant.clientName)}</p>
${verified}
<p><span class="muted">Returns to</span> ${escapeHtml(grant.redirectHost)}</p>
<p><span class="muted">Access</span> ${grant.scope.split(" ").includes("mail.send") ? "Read and send" : "Read only"}</p>
<p><span class="muted">Connected</span> ${escapeHtml(grant.createdAt)}</p>
<p><span class="muted">Last used</span> ${escapeHtml(grant.lastUsedAt ?? "Never")}</p>
<form method="post" action="/apps/${escapeHtml(grant.id)}/revoke"><input type="hidden" name="_csrf" value="${escapeHtml(csrf)}"><button class="secondary" type="submit">Disconnect</button></form>
</li>`;
    })
    .join("");
  return `<section id="connected-apps"><h2>Connected apps</h2>${intro}<ul class="records">${items}</ul></section>`;
}

function oauthSection(mcpUrl: string | null): string {
  const url = mcpUrl ?? "Set OPENMAIL_PUBLIC_URL";
  return `<section id="oauth-connect"><h2>Connect with sign-in (OAuth)</h2>
<p>For assistants that support MCP sign-in, such as Claude or ChatGPT: add OpenMail as a custom connector with just this URL. You will be sent here to log in and approve read-only access. No API key needed.</p>
${copyField("MCP URL", url, "dash-oauth-url")}
</section>`;
}

export interface ConsentView {
  csrf: string;
  email: string;
  clientName: string;
  clientKind: "dcr" | "cimd";
  /** The full metadata-document URL for CIMD clients, otherwise empty. */
  clientUrl: string;
  /** The exact redirect_uri of this request. */
  redirectUri: string;
  redirectHost: string;
  loopback: boolean;
  accounts: MailAccountSummary[];
  params: Record<string, string>;
  sendRequested?: boolean;
}

/** "<app> wants read-only access to your OpenMail mailboxes" with Allow / Deny. */
export function consentPage(view: ConsentView): string {
  const hidden = Object.entries(view.params)
    .map(([name, value]) => `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`)
    .join("\n");
  const identity =
    view.clientKind === "cimd"
      ? `<p class="fine">${icon("shield")} The app's details were published at <strong class="consent-url">${escapeHtml(view.clientUrl)}</strong>. Only allow it if you trust that address.</p>`
      : `<p class="fine">${icon("shield")} The name “${escapeHtml(view.clientName)}” was supplied by the app itself and is not verified. Check where you will be sent back to below.</p>`;
  const loopback = view.loopback
    ? `<div class="notice warn" role="note"><p>This app runs on your own computer (<strong>${escapeHtml(view.redirectHost)}</strong>). Only allow it if you started this connection yourself just now.</p></div>`
    : "";
  const mailboxes =
    view.accounts.length === 0
      ? `<p class="muted">You have no mailboxes yet. After connecting, add one from your <a href="/dashboard">dashboard</a>.</p>`
      : `<ul class="consent-list">${view.accounts
          .map((a) => `<li>${icon("inbox")}<span><strong>${escapeHtml(a.name)}</strong> · ${escapeHtml(a.email)}</span></li>`)
          .join("")}</ul>`;
  const sendChoice = view.sendRequested
    ? `<h2>Send email as you</h2>
<label class="check"><input name="allow_send" type="checkbox" value="on"> Also allow ${escapeHtml(view.clientName)} to send email from mailboxes where you turned on sending. Your assistant must show you each email and ask before sending.</label>`
    : "";
  const cannotSend = view.sendRequested
    ? "Send email unless you tick the box above. It cannot delete, move or flag mail, or mark it as read"
    : "Send, delete, move or flag mail, or mark it as read";
  return layout(
    "Allow access · OpenMail",
    `<div class="auth"><div class="card auth-card consent">
<a class="auth-logo" href="/"><img src="/logo.svg" alt="OpenMail" width="56" height="56"></a>
<h1><span class="consent-app">${escapeHtml(view.clientName)}</span> ${view.sendRequested ? "wants access" : "wants read-only access"} to your OpenMail mailboxes</h1>
<p class="muted">Signed in as ${escapeHtml(view.email)}</p>
${identity}
${loopback}
<h2>It will be able to</h2>
<ul class="consent-list">
<li>${icon("check")}<span>List your mailboxes and folders</span></li>
<li>${icon("check")}<span>Search and read your messages and threads</span></li>
</ul>
<form method="post" action="/oauth/authorize">
<input type="hidden" name="_csrf" value="${escapeHtml(view.csrf)}">
${hidden}
${sendChoice}
<h2>It will not be able to</h2>
<ul class="consent-list">
<li>${icon("lock")}<span>${cannotSend}</span></li>
<li>${icon("lock")}<span>See your mailbox passwords or your OpenMail password</span></li>
</ul>
<h2>Mailboxes it can read</h2>
${mailboxes}
<p>After you choose, you will be sent back to <strong>${escapeHtml(view.redirectHost)}</strong>:</p>
<p class="fine consent-url">${escapeHtml(view.redirectUri)}</p>
<div class="consent-actions">
<button class="btn btn-primary" type="submit" name="decision" value="allow">Allow</button>
<button class="btn btn-secondary" type="submit" name="decision" value="deny">Deny</button>
</div>
</form>
<p class="fine">You can disconnect it at any time under Connected apps on your dashboard.</p>
</div></div>`,
    { csrf: view.csrf, path: "/oauth/authorize", description: "Approve an app's read-only access to your OpenMail mailboxes." },
  );
}

/** Shown when the request cannot safely be sent back to the app (bad client or redirect_uri). */
export function oauthErrorPage(title: string, text: string): string {
  return layout(
    `${title} · OpenMail`,
    `<div class="card status"><h1>${escapeHtml(title)}</h1><p>${escapeHtml(text)}</p><p class="muted">Go back to the app and try connecting again. If it keeps happening, contact <a href="mailto:${SUPPORT_EMAIL}">${SUPPORT_EMAIL}</a>.</p><p><a class="btn btn-secondary" href="/">Home</a></p></div>`,
  );
}

function option(value: string, label: string, selected: boolean): string {
  return `<option value="${escapeHtml(value)}"${selected ? " selected" : ""}>${escapeHtml(label)}</option>`;
}
