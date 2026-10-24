# OpenMail security

## Secrets

- **Master key** (`OPENMAIL_MASTER_KEY`): 32 bytes, standard base64. Required in multi mode. Missing or invalid → process refuses to start. Generate with:

  ```bash
  node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
  ```

- **Per-user data key**: random 32 bytes at signup, wrapped with the master key (AES-256-GCM, AAD `user:<userId>`).
- **Mailbox passwords**: sealed with the unwrapped user key (AES-256-GCM, AAD `account:<accountId>`). Decrypted only when opening IMAP. Never returned by HTTP or MCP, never written into HTML, never logged.
- **API keys**: `om_` + random secret. Only SHA-256 hex is stored. Full key shown once at creation. Prefix (about 12 characters) is listed afterward.
- **Sessions**: random token in `om_session` cookie; only SHA-256 of the token is stored. HttpOnly, SameSite=Lax, Secure (unless `OPENMAIL_INSECURE_COOKIES=1` in non-production for local HTTP).

## Web UI

- CSRF on every POST: session secret in a hidden `_csrf` field after login; double-submit `om_csrf` cookie for signup/login.
- Login and signup rate-limited per IP and per email (10 attempts / 15 minutes by default) → `429`.
- Account passwords: minimum 10 characters for user accounts; zod validation with friendly form errors; password fields are never re-filled.
- Adding a mail account always probes IMAP first; save only on success. "Test connection", "Save", and turning on "Allow sending" (which checks SMTP first) share a per-user limit (20 sign-in attempts / 15 minutes) → `429`.
- Custom hosts must resolve only to public addresses (no loopback, private, link-local, CGNAT, multicast or documentation ranges, IPv4 or IPv6) and use standard ports (IMAP 143/993, SMTP 465/587/2525). This stops the probe being used to scan the server's own network. Presets skip this form check because their hosts are fixed. Plain SMTP is refused except for loopback in local tests or an exact hostname in `OPENMAIL_INSECURE_SMTP_HOSTS` (the hosted demo uses `demo-mail` only). TLS certificate checks cannot be turned off.
- Every IMAP connection (probe, MCP tool, CLI) resolves the host again, refuses it if any address is private, and connects to the checked IP while TLS still verifies the certificate against the original hostname. A hostname that is re-pointed at `127.0.0.1` or `169.254.169.254` after it was saved (DNS rebinding) is refused with `blocked_host`. Only operator-trusted hosts skip this: loopback with `OPENMAIL_ALLOW_INSECURE_LOCALHOST=1`, and exact names on `OPENMAIL_INSECURE_IMAP_HOSTS`.
- Per-user caps: 25 mail accounts and 25 active API keys.
- CSP, `Referrer-Policy: no-referrer`, `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Permissions-Policy` and `Cross-Origin-Opener-Policy: same-origin` on all responses. HSTS when the request is HTTPS, `OPENMAIL_PUBLIC_URL` is `https://…`, or (with `OPENMAIL_TRUST_PROXY=1`) `X-Forwarded-Proto: https`.

## OAuth 2.1 (sign in with OpenMail)

- OpenMail is its own authorization server (`src/oauth/`). Enabled only when `OPENMAIL_PUBLIC_URL` is `https://…`; issuer is that origin, resource is `<origin>/mcp`.
- Discovery: RFC 9728 protected resource metadata (`/.well-known/oauth-protected-resource[/mcp]`), RFC 8414 server metadata (`/.well-known/oauth-authorization-server`). `401` on `/mcp` sends `resource_metadata` and `scope="mail.read mail.send"`, plus `error="invalid_token"` when a token was presented. `mail.send` is granted only when the consent checkbox is ticked.
- Clients: Client ID Metadata Documents (public clients, `none` only; `private_key_jwt` is refused) and Dynamic Client Registration (`none`, `client_secret_post`, `client_secret_basic`; secrets stored as SHA-256). Registration is limited to 20 per address per hour, 10 redirect URIs, 5,000 registered clients in total; unused registrations are pruned after 7 days.
- CIMD fetches: `https` on port 443, the URL must equal the document's `client_id` exactly and contain a path without dot segments or query. DNS is resolved once, every address must be public (same blocklist as IMAP hosts), the socket is pinned to the checked address, redirects are not followed, 5 s deadline, 32 KB cap, TLS verified. Documents with a `client_secret` are rejected. Cached 5 to 60 minutes (Cache-Control `max-age`, default 15 min; `no-store` or `max-age=0` for 1 minute). An unknown `redirect_uri` triggers at most one refetch per client per minute; fetches are also limited per host (10/min) and overall (120/min). Network failures all return the same message so the endpoint is not a DNS oracle. Expired cached documents with no live grant are deleted.
- Authorize: `response_type=code` only; PKCE `S256` required; repeated parameters rejected; `state` ≤ 1,000 characters; `resource` must be the MCP URL (or its origin). An unknown client or unregistered `redirect_uri` shows an error page and never redirects. Other errors redirect with `error`, `state` and `iss`.
- Redirect URIs: https, or http on `localhost`/`127.0.0.1`/`[::1]` (port may differ, RFC 8252 §7.3). Exact match otherwise. No fragments, userinfo or custom schemes.
- Consent shows the app name (marked unverified for DCR), the full CIMD document URL, and the exact `redirect_uri`, with a warning when it is a loopback address. Token-endpoint errors use one `invalid_grant` description per grant type.
- Login: an unauthenticated authorize request goes to `/login?next=…`. `next` is accepted only if it is a path to `/oauth/authorize` on this site, so it cannot become an open redirect.
- Consent: CSRF token tied to the session, `frame-ancestors 'none'` and `X-Frame-Options: DENY`. The page CSP adds only the callback's origin to `form-action` (browsers apply it to the redirect after the form post). App names are stripped of control and bidi characters and HTML-escaped; DCR names are labelled as unverified; the callback host is always shown; loopback-only apps get an extra warning.
- Tokens: random 256-bit values with prefixes (`omc_` code, `oma_` access, `omr_` refresh), stored as SHA-256. Code: 5 minutes, single use, bound to client, redirect URI, PKCE challenge and resource; reuse revokes tokens issued from it. Access: 1 hour; a refresh retires the previous access token. Each token stores the scope it was issued: a refresh can drop `mail.send`, and omitting `scope` keeps the previous refresh token's scope (or the grant's, for a token from before that column). The grant scope stays the ceiling. Refresh: 30 days, rotated on each use; presenting a rotated one revokes the grant. Revoking a refresh token (RFC 7009) or disconnecting in the dashboard revokes the whole grant.
- `/mcp` validates OAuth tokens for expiry, revocation, audience (`resource`) and the `mail.read` scope, then applies the same per-user isolation as API keys.

## Sending

- `send_message` sends plain text only. Every recipient is an address the caller passes. A reply does not copy Reply-To, From, To, or Cc from the original; `read_message` returns those headers so they can be shown and then passed explicitly. A reply-all is a reply plus the Cc the user approved.
- Forwarded files are included only when `include_attachments` is true, after the file names have been shown. At most 20 files and 15 MB. Filenames and content types taken from the original are sanitized.
- The send log stores time, mailbox label, recipient count, status, message id, and which connection sent it. It does not store the body, subject, or addresses. Rows are kept 90 days. An attempt still in progress is listed as "in progress" and counts toward the limit; one left unfinished for more than 5 minutes is marked interrupted at startup and still counts.
- In single-user config mode the send log and the rate limits are in memory only and reset when the process exits.

## MCP

- Bearer token required on `/mcp` (API key or OAuth access token). Unknown, expired or revoked → `401`.
- Per-key sliding window (60/min) → `429`. More than 30 failed bearer attempts a minute from one client address → `429`. Bodies over 1 MB → `413`.
- Resource limits: `read_message` fetches at most 10 MB of a message and `read_thread` at most 1 MB per message (100 messages), always as `BODY.PEEK[]<0.n>` partial fetches; a `has_attachment` search checks at most 2,000 messages; tool string inputs have length limits; IMAP connect/greeting timeouts are 15 s and the socket idle timeout is 60 s.
- Tools are scoped to the authenticated user. Another user’s account id is `not_found`; IMAP is not contacted.
- Message bodies, subjects, and headers are untrusted third-party content. Tool descriptions and results state that this content is data, not instructions.

## Transport

- TLS certificate verification is never disabled.
- Plain IMAP only for loopback hosts when `OPENMAIL_ALLOW_INSECURE_LOCALHOST=1` (tests / local GreenMail). Leave it off in production.
- `OPENMAIL_INSECURE_IMAP_HOSTS` is an operator allowlist of exact hostnames (no wildcards) that may use plain IMAP. Production lists only `demo-mail`, the internal reviewer demo server. The web probe never passes this list, and the custom-host guard rejects private addresses, so a user-entered host always needs TLS. The admin CLI accepts a custom host only if it is on the list.

## Operator CLI

`node dist/cli/admin.js` (inside the container: `docker compose exec -T openmail node dist/cli/admin.js …`). Passwords and keys are read from stdin or `--password-env VAR`, never from argv, and the CLI prints only ids, names and counts. `delete-user --email <e> --yes` removes a user with their sessions, keys and mailboxes. `set-password --email <e>` (new password on stdin) replaces a login password and signs out that user's web sessions; API keys keep working.

## Proxy

With `OPENMAIL_TRUST_PROXY=1`, the client address for rate limits is the last `X-Forwarded-For` entry (the one the proxy appended).
