# OpenMail architecture

OpenMail is a provider-agnostic IMAP/SMTP bridge exposed as a [Model Context Protocol](https://modelcontextprotocol.io) server. Agents never open mail ports themselves; they call OpenMail over HTTPS, and OpenMail connects outbound to mailbox providers.

```
agent  --443/HTTPS-->  OpenMail (/mcp + setup UI)  --993/465/587-->  mailbox provider
                              |
                              +-- SQLite (multi) or config.toml (single)
                              +-- envelope-encrypted mailbox passwords
                              +-- read-only IMAP tools
```

## Modes

| Mode | How to select | Credentials | Auth |
| --- | --- | --- | --- |
| `multi` (default) | `OPENMAIL_MODE=multi` or omit | SQLite + `OPENMAIL_MASTER_KEY` | Per-user API keys from the setup UI |
| `single` | `OPENMAIL_MODE=single` | `config.toml` + `password_env` | `OPENMAIL_API_KEYS` (SHA-256 hashed) |

Multi-user is the hosted / shared path. Single-user remains for self-hosting one operator with a static key list.

## Layout

| Path | Role |
| --- | --- |
| `src/config` | Load `config.toml` (smol-toml) and validate with zod. Passwords are env-var names, never inline values. |
| `src/db` | SQLite open + numbered migrations (`users`, `sessions`, `api_keys`, `mail_accounts`). |
| `src/crypto` | Master key load, per-user data-key wrap, mailbox password seal/unseal, API key generation. |
| `src/services` | Users, sessions' consumers, API keys, mail accounts (user-scoped). |
| `src/store` | `CredentialStore`: `SqliteCredentialStore` (multi) and `ConfigCredentialStore` (single). |
| `src/mail` | Presets, TLS policy, IMAP gateway, read-only operations. |
| `src/tools` | MCP tool registration and zod input schemas. |
| `src/server` | One HTTP server for `/healthz`, `/mcp`, and (multi) the setup UI. Bearer auth, body limit, per-key rate limit. |
| `src/web` | Server-rendered landing, signup/login/dashboard, privacy, terms, reviewer guide, CSRF, session cookies, security headers, custom-host guard, static CSS/JS/logo. |
| `src/cli/admin.ts` | Operator CLI (`node dist/cli/admin.js`): list/create users, add a mailbox, import an existing API key. Secrets come from stdin or a named env var. |
| `src/demo` | Fictional demo messages and an idempotent seeder that keeps the reviewer demo mailbox filled. |

## HTTP surface

Same process and port for everything:

- `GET /healthz` — unauthenticated liveness
- `POST /mcp` — streamable HTTP MCP (bearer required)
- Setup UI (`/`, `/signup`, `/login`, `/dashboard`, accounts, keys, `/privacy`, `/terms`, `/reviewers`, `/logo.svg`, `/logo.png`, `/favicon.ico`, `/static/*`) — multi mode only

`OPENMAIL_PUBLIC_URL` is the public origin shown in the dashboard “Connect to Grok Bot” section (MCP URL becomes `{origin}/mcp`).

## Account ids

`list_accounts` returns each account's id (a UUID) and label. Tools accept either, scoped to the key's user, so `ttt-umer` and its UUID both work for the owner and neither works for anyone else.

## Reviewer demo mailbox

The production compose file can run GreenMail (`demo-mail`) on an `internal: true` Docker network with no published ports. Only the OpenMail container shares that network. `OPENMAIL_DEMO_*` settings make OpenMail seed fictional messages at startup and every 2 minutes (`OPENMAIL_DEMO_RESEED_SECONDS`) (GreenMail keeps mail in memory, so a restart is refilled automatically). The seeder appends only messages whose Message-ID is missing.

## Mail access

Read tools use read-only mailbox locks (`EXAMINE`) and `BODY.PEEK`, so reads do not set `\Seen`. TLS verification stays on. Plain IMAP is allowed only for loopback when `OPENMAIL_ALLOW_INSECURE_LOCALHOST=1` (or `allow_insecure_localhost` in config) — for GreenMail and similar local fixtures, not production providers.
