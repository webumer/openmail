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
- Adding a mail account always probes IMAP first; save only on success. "Test connection" and "Save" share a per-user limit (20 sign-in attempts / 15 minutes) → `429`.
- Custom hosts must resolve only to public addresses (no loopback, private, link-local, CGNAT, multicast or documentation ranges, IPv4 or IPv6) and use standard ports (IMAP 143/993, SMTP 25/465/587/2525). This stops the probe being used to scan the server's own network. Presets skip this form check because their hosts are fixed.
- Every IMAP connection (probe, MCP tool, CLI) resolves the host again, refuses it if any address is private, and connects to the checked IP while TLS still verifies the certificate against the original hostname. A hostname that is re-pointed at `127.0.0.1` or `169.254.169.254` after it was saved (DNS rebinding) is refused with `blocked_host`. Only operator-trusted hosts skip this: loopback with `OPENMAIL_ALLOW_INSECURE_LOCALHOST=1`, and exact names on `OPENMAIL_INSECURE_IMAP_HOSTS`.
- Per-user caps: 25 mail accounts and 25 active API keys.
- CSP, `Referrer-Policy: no-referrer`, `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Permissions-Policy` and `Cross-Origin-Opener-Policy: same-origin` on all responses. HSTS when the request is HTTPS, `OPENMAIL_PUBLIC_URL` is `https://…`, or (with `OPENMAIL_TRUST_PROXY=1`) `X-Forwarded-Proto: https`.

## MCP

- Bearer token required on `/mcp`. Unknown or revoked key → `401`.
- Per-key sliding window (60/min) → `429`. More than 30 failed bearer attempts a minute from one client address → `429`. Bodies over 1 MB → `413`.
- Resource limits: `read_message` fetches at most 10 MB of a message and `read_thread` at most 1 MB per message (100 messages), always as `BODY.PEEK[]<0.n>` partial fetches; a `has_attachment` search checks at most 2,000 messages; tool string inputs have length limits; IMAP connect/greeting timeouts are 15 s and the socket idle timeout is 60 s.
- Tools are scoped to the authenticated user. Another user’s account id is `not_found`; IMAP is not contacted.
- Message bodies, subjects, and headers are untrusted third-party content. Tool descriptions warn callers not to follow instructions found in them.

## Transport

- TLS certificate verification is never disabled.
- Plain IMAP only for loopback hosts when `OPENMAIL_ALLOW_INSECURE_LOCALHOST=1` (tests / local GreenMail). Leave it off in production.
- `OPENMAIL_INSECURE_IMAP_HOSTS` is an operator allowlist of exact hostnames (no wildcards) that may use plain IMAP. Production lists only `demo-mail`, the internal reviewer demo server. The web probe never passes this list, and the custom-host guard rejects private addresses, so a user-entered host always needs TLS. The admin CLI accepts a custom host only if it is on the list.

## Operator CLI

`node dist/cli/admin.js` (inside the container: `docker compose exec -T openmail node dist/cli/admin.js …`). Passwords and keys are read from stdin or `--password-env VAR`, never from argv, and the CLI prints only ids, names and counts. `delete-user --email <e> --yes` removes a user with their sessions, keys and mailboxes.

## Proxy

With `OPENMAIL_TRUST_PROXY=1`, the client address for rate limits is the last `X-Forwarded-For` entry (the one the proxy appended).
