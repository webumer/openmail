# Security policy

OpenMail lets AI assistants read people's email, so we take security reports seriously.

## Reporting a vulnerability

Email **support@openmail.tools** with:

- what you found and where (URL, file, or tool name),
- steps to reproduce, and
- the impact you think it has.

Please do not open a public GitHub issue for a vulnerability, and do not access, change or delete anyone else's data while testing. Test only with accounts and mailboxes you own. Do not run denial-of-service or volume tests against `mcp.openmail.tools`.

We aim to reply within 3 working days, and to fix confirmed critical or high issues within 14 days. We are happy to credit you once a fix is live, if you want that.

## Supported versions

Only the latest release on `main`, which is what runs at https://mcp.openmail.tools, receives security fixes.

## What OpenMail stores

| Data | How it is stored |
|---|---|
| Your login email | Plain text (needed to sign in) |
| Your login password | Argon2id hash only (19 MiB memory, 2 passes) |
| Session cookie | SHA-256 of a random 256-bit token; expires after 7 days |
| API keys | SHA-256 of the key only; the key itself is shown once |
| OAuth codes, access and refresh tokens, client secrets | SHA-256 only. Codes last 5 minutes and work once; access tokens last 1 hour; refresh tokens rotate on every use and last 30 days |
| OAuth app registrations | App name, redirect URIs and, for apps that identify with a Client ID Metadata Document, a cached copy of that public document |
| Mailbox settings (host, port, username, address, name) | Plain text |
| Mailbox passwords | AES-256-GCM, with a per-user data key that is itself wrapped by the server master key (envelope encryption, ids bound as AAD) |
| Optional SMTP password | Same encryption, with a different binding (`account id` + `:smtp`) so it cannot be swapped with the IMAP password |
| Send log | Time, mailbox label, recipient count, status, message id, and which connection sent it. No body, subject, or addresses. Kept 90 days in multi-user mode. In single-user config mode the send log and the rate limits are in memory only and reset when the process exits. |
| Email content | **Not stored.** Messages are fetched from your IMAP server on each request and passed back to your assistant. |

Logs contain no message content, passwords or keys.

## Threat model

**What we defend against**

- *Other users of the service.* Every tool call and dashboard action is scoped to the user who owns the API key or session. Another user's account id simply returns `not_found`.
- *Stolen database.* Mailbox passwords cannot be read without the master key, which lives only in the server environment. Login passwords and API keys are hashed.
- *Malicious web pages.* CSRF tokens on every form, `SameSite` cookies, a strict Content-Security-Policy with no inline script, `frame-ancestors 'none'`, HSTS.
- *Using OpenMail to reach private networks (SSRF).* Custom IMAP hosts must resolve to public addresses and standard ports. The check runs again at every connection and the socket is pinned to the checked address, so DNS rebinding to `127.0.0.1`, `169.254.169.254` or internal Docker hosts is refused.
- *Network attackers.* TLS certificate verification is always on. Plain IMAP is only allowed for operator-configured internal hosts (the reviewer demo mailbox).
- *Changing your mailbox.* Reads open folders with `EXAMINE` and fetch with `BODY.PEEK`, so messages are never marked as read. Nothing deletes, moves, or flags mail. The only IMAP write is appending the copy of a message you confirmed to Sent.
- *Sending mail you did not approve.* Sending is off until you turn it on for that mailbox, and the connection also needs permission (`mail.send`, or an API key created as “Read and send”). The assistant must show the full email and set `user_confirmed` only after you agree. Sends are rate limited and recorded without the message content.
- *Prompt injection through email.* Email content is attacker-controlled. Every tool result is labelled as untrusted third-party content and tool descriptions tell the assistant never to follow instructions inside messages. This reduces the risk; it cannot remove it, so assistants should still ask you before acting on what an email says.
- *Malicious or impersonating apps (OAuth).* Every connection needs you to log in and click **Allow** on a consent screen that names the app, says whether its identity was verified by its domain (Client ID Metadata Document) or only self-reported (Dynamic Client Registration), and shows where you will be sent back to. PKCE S256 is mandatory, redirect URIs must match a registered one exactly (loopback may differ only in port), codes work once, tokens are bound to `https://mcp.openmail.tools/mcp`, and a reused refresh token revokes the whole connection. The consent page cannot be framed and its form is CSRF-protected. Metadata documents are fetched over https on port 443 only, from public addresses only (pinned, no redirects, 5 s, 32 KB).
- *Abuse and exhaustion.* Rate limits on login, signup, mailbox tests and API calls; message size caps; IMAP timeouts; per-user caps on mailboxes and keys.

**What is out of scope**

- Someone with root on the server. They can read the master key and decrypt mailbox passwords. Run OpenMail on a host only you control.
- Your mail provider, or your assistant deciding to act on a malicious email.
- Someone who has your API key. Treat it like a password and revoke it from the dashboard if it leaks. The same goes for an app you approved: disconnect it under **Connected apps**.

## Self-hosting checklist

- Generate a fresh `OPENMAIL_MASTER_KEY` (`openssl rand -base64 32`), keep `.env` at `chmod 600`, and never commit it.
- Keep `allow_insecure_localhost = false` and leave `OPENMAIL_INSECURE_IMAP_HOSTS` and `OPENMAIL_INSECURE_SMTP_HOSTS` empty unless you run an internal demo server. The hosted demo sets both to `demo-mail` only.
- Publish only Caddy's ports 80/443; OpenMail's port 8080 stays on the private Docker network. Set `OPENMAIL_TRUST_PROXY=1` only behind such a proxy.

More detail: [docs/security.md](docs/security.md).
