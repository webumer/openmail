# OpenMail

OpenMail (openmail.tools) is a hosted, provider-agnostic IMAP/SMTP server for AI agents, exposed as a [Model Context Protocol](https://modelcontextprotocol.io) endpoint. It is open source (MIT) and written in TypeScript for Node.js 22.

Agents do not open IMAP or SMTP themselves. They call a remote MCP server over HTTPS. The public endpoint is:

**https://mcp.openmail.tools/mcp**

That server speaks MCP streamable HTTP (`POST` on `/mcp`, plus an unauthenticated `GET /healthz`). In multi-user mode the same process also serves a small setup UI (signup, mail accounts, API keys). The hosted process is the one that connects outbound to mailbox providers.

Agent sandboxes often allow outbound traffic only on port 443. IMAP (993) and SMTP (465 / 587) are not reachable from those sandboxes, so OpenMail has to run somewhere those mail ports are reachable — the hosted server, or your own deployment on a network that can open them. The agent only needs HTTPS to OpenMail.

## Architecture

Tool reference (inputs, outputs, errors, limits): [docs/tools.md](docs/tools.md). See [docs/architecture.md](docs/architecture.md) for modes, package layout, and the HTTP surface. Security details (encryption, CSRF, headers, TLS policy) are in [docs/security.md](docs/security.md). To report a vulnerability, see [SECURITY.md](SECURITY.md).

```
agent  --443/HTTPS-->  https://mcp.openmail.tools/mcp  --993/465/587-->  mailbox provider
                              |
                              +-- SQLite users / keys / encrypted mailbox passwords
                              +-- setup UI (same origin)
                              +-- read tools, and send when you turn it on
```

Read tools always open mailboxes read-only (`EXAMINE`) and fetch with `BODY.PEEK`, so a read does not set `\Seen`. The only IMAP write is appending a copy of a message you sent to the Sent folder. TLS verification stays on. Plain IMAP or SMTP is allowed only for loopback when `OPENMAIL_ALLOW_INSECURE_LOCALHOST=1` (local test servers), or for an exact hostname in `OPENMAIL_INSECURE_IMAP_HOSTS` / `OPENMAIL_INSECURE_SMTP_HOSTS` (the demo mailbox).

### Provider presets

| Preset | IMAP | SMTP |
| --- | --- | --- |
| `migadu` | `imap.migadu.com:993` TLS | `smtp.migadu.com:465` TLS |
| `fastmail` | `imap.fastmail.com:993` TLS | `smtp.fastmail.com:465` TLS |
| `zoho` | `imap.zoho.com:993` TLS | `smtp.zoho.com:465` TLS |
| `icloud` | `imap.mail.me.com:993` TLS | `smtp.mail.me.com:587` STARTTLS |
| `gmail` | `imap.gmail.com:993` TLS | `smtp.gmail.com:465` TLS (App Password). Gmail stores its own Sent copy. |
| `custom` | host and port from config / form | host and port from config / form |

Zoho EU and IN use `imap.zoho.eu` / `smtp.zoho.eu` and `imap.zoho.in` / `smtp.zoho.in`.

### Read-only operations

Results use `{ ok, data, truncated, warnings }`. Failures use `{ ok: false, error: { code, message }, warnings }`.

- `list_accounts` — id, label, email, preset, IMAP host, and whether sending is enabled. Never passwords.
- `send_message` — sends one plain-text email over SMTP after the assistant has shown it and the user confirmed. Every recipient is passed explicitly. Off unless sending is enabled for that mailbox and allowed for the connection.
- `list_folders` — path, name, special-use, delimiter, and STATUS counts when available.
- `search_messages` — newest first, default 20, max 50, opaque base64 cursor.
- `read_message` — headers, plain text (HTML stripped when needed), 20,000 character cap, attachment metadata without bytes.
- `read_thread` — Message-ID / In-Reply-To / References chain, oldest first, 40,000 character combined cap.

Message bodies, subjects, and headers are untrusted third-party content. Passwords, message bodies, and API keys are not logged.

## Multi-user setup (default)

```bash
export OPENMAIL_MASTER_KEY="$(node -e "console.log(require('crypto').randomBytes(32).toString('base64'))")"
# optional:
# export OPENMAIL_DB_PATH=./data/openmail.db
# export OPENMAIL_PUBLIC_URL=https://mcp.example.com
# export OPENMAIL_INSECURE_COOKIES=1   # local HTTP only; refused when NODE_ENV=production
npm install
npm run build
npm start
```

Open `http://127.0.0.1:8080/`, sign up, add a mailbox (presets auto-fill host/port; “Test connection” probes IMAP before save), create an API key, and copy the key once from the reveal page.

| Variable | Purpose |
| --- | --- |
| `OPENMAIL_MASTER_KEY` | Required in multi mode. 32-byte key as standard base64. |
| `OPENMAIL_DB_PATH` | SQLite path (default `./data/openmail.db`). |
| `OPENMAIL_PUBLIC_URL` | Public origin for the dashboard MCP URL (e.g. `https://mcp.openmail.tools`). |
| `OPENMAIL_MODE` | `multi` (default) or `single`. |
| `OPENMAIL_INSECURE_COOKIES` | `1` to omit `Secure` on cookies for local HTTP (non-production only). |
| `OPENMAIL_TRUST_PROXY` | `1` to trust `X-Forwarded-Proto` / `X-Forwarded-For`. |
| `OPENMAIL_ALLOW_INSECURE_LOCALHOST` | `1` to allow plain IMAP to loopback (tests only). |
| `OPENMAIL_INSECURE_IMAP_HOSTS` | Comma-separated exact hostnames allowed to use plain IMAP (operator-run internal servers only, e.g. `demo-mail`). |
| `OPENMAIL_DEMO_IMAP_HOST`, `OPENMAIL_DEMO_IMAP_PORT`, `OPENMAIL_DEMO_IMAP_USER`, `OPENMAIL_DEMO_PASSWORD` | Optional reviewer demo mailbox that OpenMail keeps seeded with fictional messages. |

Generate a master key once and store it like any other secret:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

## Single-user mode

For one operator with `config.toml` and static keys:

```bash
cp config.example.toml config.toml
export OPENMAIL_MODE=single
export OPENMAIL_ACCT_WORK_PASSWORD="..."
export OPENMAIL_API_KEYS="replace-with-a-long-random-key"
npm install
npm run build
npm start
```

`OPENMAIL_CONFIG` selects the config file (default `./config.toml`). `config.toml` is gitignored; `config.example.toml` has placeholders only.

In single-user mode the send log and the send rate limits are kept in memory only. They reset when the process exits. Multi-user mode stores them in SQLite.

## Two ways to connect

OpenMail accepts two kinds of bearer token on `/mcp`. Both map to the same OpenMail user and see exactly the same mailboxes.

| | Sign in with OpenMail (OAuth 2.1) | API key |
|---|---|---|
| For | Clients that support MCP authorization: Claude (custom connectors, Claude Code), ChatGPT, MCP Inspector, Muse, … | Grok Bot and clients that send a fixed header |
| Setup | Add the MCP URL only. The client opens OpenMail, you log in and click **Allow** | Create a key in the dashboard and send `Authorization: Bearer <key>` |
| Token | Opaque access token, 1 hour, refreshed automatically (refresh tokens rotate) | Long-lived until you revoke it |
| Revoke | Dashboard → **Connected apps** → Disconnect | Dashboard → **API keys** → Revoke |

### OAuth details

OpenMail is its own authorization server on the same origin, following the [MCP authorization spec](https://modelcontextprotocol.io/specification/draft/basic/authorization):

- `401` from `/mcp` carries `WWW-Authenticate: Bearer resource_metadata="https://mcp.openmail.tools/.well-known/oauth-protected-resource/mcp", scope="mail.read mail.send"`.
- Protected Resource Metadata (RFC 9728): `/.well-known/oauth-protected-resource` and `/.well-known/oauth-protected-resource/mcp`. Resource: `https://mcp.openmail.tools/mcp`.
- Authorization Server Metadata (RFC 8414): `/.well-known/oauth-authorization-server`. Issuer: `https://mcp.openmail.tools`.
- Client registration: Client ID Metadata Documents (`client_id_metadata_document_supported: true`, public clients with `none`) and Dynamic Client Registration (RFC 7591) at `/oauth/register`.
- `/oauth/authorize`: authorization code with **PKCE S256 required**, `state`, exact `redirect_uri` matching (https, or http loopback on any port per RFC 8252), `resource` (RFC 8707) bound to the MCP URL, and `iss` in every response (RFC 9207).
- `/oauth/token`: code exchange and refresh with rotation and reuse detection (reusing a refresh token revokes the whole connection). `/oauth/revoke` (RFC 7009).
- Scopes: `mail.read` (always) and `mail.send` (only if the user ticks the box on the consent screen). `mail.send` never widens a mailbox that has sending turned off.

Redirect URIs known to work: `https://claude.ai/api/mcp/auth_callback`, Claude Code loopback (`http://localhost:<port>/callback`), ChatGPT (`https://chatgpt.com/connector_platform_oauth_redirect`, via its CIMD document), MCP Inspector (`http://localhost:6274/oauth/callback`). Custom URL schemes (for example `cursor://`) are not accepted yet.

OAuth is enabled when `OPENMAIL_PUBLIC_URL` is an `https://` URL. For OpenAI domain verification, set `OPENMAIL_OPENAI_CHALLENGE` to the token OpenAI gives you; it is served at `/.well-known/openai-apps-challenge`.

### API key (Grok Bot)

Add a streamable HTTP MCP server:

| Field | Value |
| --- | --- |
| URL | `https://mcp.openmail.tools/mcp` (hosted) or `{OPENMAIL_PUBLIC_URL}/mcp` / `http://127.0.0.1:8080/mcp` (self-hosted) |
| Header | `Authorization: Bearer <your API key>` |

In multi mode, create the key in the dashboard; the “Connect to Grok Bot” section shows the MCP URL and header format. In single mode, use a key from `OPENMAIL_API_KEYS`. `GET /healthz` on that origin stays unauthenticated.

## Run

Requires Node.js 22.

```bash
npm install
npm run build
npm start
```

`npm run dev` reloads `src/index.ts` while you edit. Default listen address is `127.0.0.1:8080` (override with `[server]` in config when present).

`GET /healthz` does not require a key. Every `/mcp` request must send `Authorization: Bearer <API key or OAuth access token>`. Unknown or revoked keys are `401`. Each accepted key is limited to 60 requests per minute (`429`). Request bodies over 1 MB are rejected (`413`).

## Operator CLI

```bash
node dist/cli/admin.js list-users
printf '%s' "$LOGIN_PASSWORD" | node dist/cli/admin.js create-user --email you@example.com
node dist/cli/admin.js add-account --user you@example.com --name work --email you@work.example --preset migadu --password-env MAILBOX_PW
printf '%s' "$EXISTING_KEY" | node dist/cli/admin.js import-key --user you@example.com --name grok
```

Secrets come from stdin or a named environment variable, never from arguments, and are never printed. See `docs/deploy.md` for running it inside Docker.

## Public pages

`/` (landing), `/privacy`, `/terms`, `/reviewers` (marketplace reviewer guide), `/logo.svg`, `/logo.png`, `/og.png` (1200×630 social preview). The landing page is server-rendered HTML with one stylesheet and a tiny copy-button script (`/static/site.js`), no external assets, light and dark mode.

## Tests

```bash
npm run typecheck
npm test
npm run test:integration
npm run test:all
```

`npm test` runs unit tests with `vitest run`. Files under `tests/integration` are excluded unless `OPENMAIL_INTEGRATION=1`.

`npm run test:integration` starts GreenMail (`greenmail/standalone:2.1.3`) with `docker compose -f docker-compose.test.yml`, waits until IMAP and SMTP accept connections, then runs `vitest run tests/integration`. Host ports default to `13143` (IMAP) and `13025` (SMTP). The fixture mailbox is `test` / `test` on localhost. Plain IMAP is allowed only with `OPENMAIL_ALLOW_INSECURE_LOCALHOST=1` in those tests. No real mailbox credentials are used.

## License

MIT. Copyright (c) 2026 Umer Sulman.
