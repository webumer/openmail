# OpenMail — Milestone 2 spec (multi-user)

Builds on M1 (mail core, MCP server, GreenMail tests). Reuse existing code; do not rewrite the mail core.

## 1. Data layer
- SQLite via `better-sqlite3` (or `node:sqlite` if better-sqlite3 cannot build). DB path from env `OPENMAIL_DB_PATH` (default `./data/openmail.db`; `data/` is gitignored). In tests use `:memory:` or a temp file.
- Simple numbered migrations in `src/db/migrations/` applied at startup inside a transaction, tracked in a `schema_migrations` table.
- Tables:
  - `users` (id TEXT uuid PK, email UNIQUE COLLATE NOCASE, password_hash TEXT argon2id via `@node-rs/argon2` or `argon2`, wrapped_data_key BLOB, created_at)
  - `sessions` (id = SHA-256 of random token, user_id, csrf_secret, created_at, expires_at)
  - `api_keys` (id, user_id, name, prefix (e.g. `om_live_ABCD1234` first ~12 chars shown), key_hash SHA-256 hex UNIQUE, created_at, last_used_at, revoked_at)
  - `mail_accounts` (id uuid, user_id, name, email, username, preset, imap_host, imap_port, imap_secure, smtp_host, smtp_port, smtp_secure, password_ciphertext BLOB, password_iv BLOB, password_tag BLOB, created_at, UNIQUE(user_id, name))
- Full API key format: `om_` + 40 chars base62/base64url random. Only hash stored. Full key shown once.

## 2. Envelope encryption (`src/crypto/`)
- `OPENMAIL_MASTER_KEY` = 32 bytes base64. Missing/invalid → server refuses to start with a clear error. Test mode: explicit `generateTestMasterKey()` helper / NODE_ENV=test may pass a generated key; never a silent fallback in production.
- On signup: random 32-byte per-user data key, wrapped with master key using AES-256-GCM (AAD = `user:<userId>`), stored as iv|tag|ciphertext.
- Mail password: AES-256-GCM with unwrapped user key, fresh 12-byte IV, AAD = `account:<accountId>`. Decrypt only at IMAP connect time.
- Tamper / wrong user key / wrong account id → decrypt throws.
- Passwords never logged, never returned by any HTTP endpoint or MCP tool, never in HTML.

## 3. Credential store
- `SqliteCredentialStore` implementing existing `CredentialStore` (userId-scoped). MCP auth: bearer key → sha256 → api_keys row (not revoked) → user_id; update last_used_at (throttled ok). Tools only see that user's accounts. Unknown account id from another user → not found.
- Keep `ConfigCredentialStore` as optional single-user self-host mode: `OPENMAIL_MODE=single` (config.toml + OPENMAIL_API_KEYS) vs default `multi`.

## 4. Setup web app (server-rendered, same server, no frontend framework)
- Routes: `GET /` (landing → login/signup links), `GET/POST /signup`, `GET/POST /login`, `POST /logout`, `GET /dashboard`, `POST /accounts` (add), `POST /accounts/test` (test IMAP login without saving), `POST /accounts/:id/delete`, `POST /keys` (create, show full key once on result page), `POST /keys/:id/revoke`.
- Session cookie `om_session`: HttpOnly, Secure (configurable off only for http://localhost in dev/tests via `OPENMAIL_INSECURE_COOKIES=1` refused unless NODE_ENV!=production), SameSite=Lax, Path=/, 7-day expiry. Store hashed session id.
- CSRF: per-session secret, hidden `_csrf` field on every form, verified on every POST (403 otherwise). Signup/login forms use a pre-session CSRF cookie (double-submit) .
- Login + signup rate limiting per IP and per email (e.g. 10/15 min) → 429.
- Password policy: min 10 chars. zod validation for every form, friendly error messages re-rendering the form (never echo password fields).
- Dashboard: add-account form with preset `<select>` (migadu/fastmail/zoho/icloud/custom); a tiny inline script (allowed by CSP via nonce or separate /static/app.js) auto-fills host/port; fields name, email, username (defaults to email), password, host/port/tls for custom. "Test connection" button (submits to /accounts/test). On add, server tests IMAP login first; save only if ok. List accounts (name, email, preset, host) — never password. Remove button.
- API keys section: create with name, list (name, prefix, created, last used, status), revoke.
- "Connect to Grok Bot" section: MCP URL from `OPENMAIL_PUBLIC_URL` (e.g. https://mcp.openmail.tools/mcp) and header `Authorization: Bearer <your key>`.
- Minimal clean CSS at /static/style.css.
- Escape all HTML output.
- For GreenMail tests, adding accounts with plain IMAP on localhost must be allowed only with existing `allow_insecure_localhost` equivalent env flag (`OPENMAIL_ALLOW_INSECURE_LOCALHOST=1`), off by default.

## 5. Security headers on all responses
CSP `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; form-action 'self'; frame-ancestors 'none'; base-uri 'none'`, `Referrer-Policy: no-referrer`, `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, HSTS (`max-age=31536000; includeSubDomains`) when request is https or `OPENMAIL_PUBLIC_URL` starts with https / behind proxy with X-Forwarded-Proto=https (trust proxy configurable).

## 6. Tests
- Unit: crypto round trip, tamper detection (iv/tag/ciphertext flip), wrong-user key fails, wrong account AAD fails, missing/invalid master key refused; api key generation/hash; migrations idempotent.
- Isolation: user A's key cannot list/read user B's accounts via MCP tools/call; revoked key → 401.
- Web flows (in-process server on ephemeral port, fetch with cookie jar): signup, login, wrong password, logout, CSRF missing/wrong → 403, login rate limit → 429, add account against GreenMail (test connection ok, bad password rejected and not saved), list shows no password, remove account, key create shows full key once then list shows only prefix, revoke → MCP 401, security headers present.
- All existing M1 tests still pass. Remove duplication between tests/auth.test.ts, tests/http.test.ts and tests/integration/mcp-http.test.ts.
