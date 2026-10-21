# OpenMail

Read and search **any IMAP mailbox** from Grok Bot, Cursor, or any MCP client. OpenMail is a hosted, open-source (MIT) remote MCP server at `https://mcp.openmail.tools/mcp`.

- **Provider-agnostic:** works with any IMAP server over TLS. Presets for Migadu, Fastmail, Zoho and iCloud; anything else (Gmail with an app password, self-hosted Dovecot, cPanel hosts) works with manual host settings.
- **Read-only today:** it never sends, deletes, moves or flags mail, and reading never marks a message as read.
- **A connector, not a mail store:** mail is fetched live from your server for each request and is not saved.

> Sending (drafts first, sent only after your explicit approval) is planned, not built.

## Setup

1. Open <https://mcp.openmail.tools> and create an account.
2. **Add a mailbox:** pick a preset or enter IMAP host/port, then your username and password (use an app password where your provider offers one). OpenMail tests the connection before saving. You can add several mailboxes.
3. **Create an API key.** It is shown once; copy it.
4. **Connect:**
   - **Grok Bot:** install OpenMail from the marketplace and paste the key when asked (it is sent as `Authorization: Bearer <key>`).
   - **Cursor / other MCP clients:** set `OPENMAIL_API_KEY` in your environment; `mcp.json` in this package sends it as the bearer header.

```json
{
  "mcpServers": {
    "openmail": {
      "url": "https://mcp.openmail.tools/mcp",
      "headers": { "Authorization": "Bearer ${OPENMAIL_API_KEY}" }
    }
  }
}
```

## Tools

| Tool | What it does |
|---|---|
| `list_accounts` | Lists the mailboxes you added (address, provider, host). Never returns passwords. |
| `list_folders` | Lists folders for an account with total and unread counts. |
| `search_messages` | Searches a folder by `from`, `to`, `subject`, `text`, `since`, `before`, `unread`, `has_attachment`. Newest first, paged (default 20, max 50 per page). |
| `read_message` | Reads one message: headers, text body (capped at 20,000 characters) and an attachment list (names, types, sizes; no file bytes). Does **not** mark it as read. |
| `read_thread` | Reads the conversation a message belongs to (up to 100 messages, 40,000 characters total). |

Example prompts:

- "List my OpenMail accounts."
- "Find unread emails from this week with attachments."
- "Search my inbox for invoices from Acme since October 1 and summarize them."
- "Read the latest reply in the site redesign thread."

## Security & privacy

- **TLS always verified** for IMAP connections; there is no option to disable certificate checks.
- **Never marks mail as read:** messages are fetched with IMAP `BODY.PEEK`.
- **No mail content stored:** messages are fetched on demand and not kept on the server or in logs.
- **Mailbox passwords encrypted at rest** with AES-256-GCM envelope encryption; they are never returned through MCP and never logged.
- **API keys are hashed** (only a short prefix is kept for display) and can be revoked at any time.
- **Untrusted content:** tool results mark email subjects, headers and bodies as untrusted third-party content so the agent does not follow instructions found inside emails.
- **Per-user isolation:** an API key only reaches the mailboxes of the account that created it.

## Limits

- Requests: 60 per minute per key (HTTP 429 above that).
- Request size: 1 MB (HTTP 413 above that).
- Search page size: 50 messages; message body 20,000 characters; thread 100 messages / 40,000 characters.
- Attachments are listed, not downloaded.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `401 Unauthorized` | The key is missing, mistyped or revoked. Create a new key and update the connector. |
| `429 Too Many Requests` | Wait a minute; you hit the per-key rate limit. |
| Mailbox fails the connection test | Check host and port (usually 993, SSL/TLS). Use an app password if your provider has 2FA (Gmail, iCloud, Fastmail, Zoho). Make sure IMAP is enabled in your provider's settings. |
| Outlook.com / Microsoft 365 rejects the password | Microsoft has turned off password (basic auth) IMAP for most accounts; OAuth support is not built yet. |
| A search returns nothing | Check the folder name with `list_folders` (e.g. `Sent` vs `Sent Items`) and widen the date range. |

## Self-hosting

OpenMail is MIT-licensed and can run on your own server with Docker Compose and Caddy. See [`docs/deploy.md`](https://github.com/webumer/openmail/blob/main/docs/deploy.md) in the repository.

## License

MIT © 2026 Umer Sulman
