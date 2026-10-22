# OpenMail — reviewer testing guide

OpenMail is a remote MCP server at `https://mcp.openmail.tools/mcp` (streamable HTTP). Five tools search and read mail and never mark it as read. `send_message` sends only when sending is turned on for that mailbox and the connection is allowed to send. The demo mailbox can send. Those messages stay on the isolated demo server and are not delivered to the internet.

- **Sign in with OpenMail (OAuth 2.1)** — for Claude, ChatGPT, Muse, MCP Inspector and other clients that implement MCP authorization. Add only the URL; no header or key.
- **API key** — for Grok Bot and clients that send a fixed header: `Authorization: Bearer <key>`, created in the OpenMail dashboard.

## 1. Reviewer account
- Sign in at https://mcp.openmail.tools as **reviewer@openmail.tools**. The password is provided with the submission (contact support@openmail.tools if you did not receive it). The account has no MFA.
- A **Demo** mailbox with fictional sample messages is already added. It is refilled automatically. Sending from it stays inside the demo server.
- Or add your own: Dashboard → *Add mailbox* → choose a preset (Migadu, Fastmail, Zoho, iCloud) or *Custom* (IMAP host, port 993 SSL/TLS) → username + app password → *Test connection* → *Save*.

## 2a. Connect with OAuth (Claude, ChatGPT, Muse, MCP Inspector)
1. Add a remote / custom MCP connector with URL `https://mcp.openmail.tools/mcp` and no authentication header.
2. The client opens OpenMail. Log in as the reviewer account.
3. The consent screen says “*App* wants read-only access to your OpenMail mailboxes”, lists the Demo mailbox and what the app can and cannot do. Click **Allow**.
4. You are sent back to the client, which is now connected.
5. To disconnect: Dashboard → *Connected apps* → *Disconnect*. The connector stops working at once.

Technical details: discovery via `/.well-known/oauth-protected-resource` (RFC 9728) and `/.well-known/oauth-authorization-server` (RFC 8414); Client ID Metadata Documents and Dynamic Client Registration; authorization code + PKCE S256; `resource` bound to `https://mcp.openmail.tools/mcp`; `iss` returned (RFC 9207); scope `mail.read`; access tokens last 1 hour; refresh tokens rotate.

## 2b. Connect with an API key (Grok Bot)
1. Dashboard → *API keys* → *Create key*. Copy it; it is shown only once.
2. Add a custom MCP connector with URL `https://mcp.openmail.tools/mcp` and header `Authorization: Bearer <key>`.
3. To disconnect: revoke the key in the dashboard.

## 3. Prompts and expected results

| Prompt | Expected |
|---|---|
| "List my OpenMail accounts" | The Demo (or your) mailbox: address, provider, host. No password anywhere. |
| "What folders are in my mailbox and how many unread?" | Folder list (INBOX, …) with total/unread counts. |
| "Find unread emails from this week" | Newest-first list with sender, subject, date, attachment flag. |
| "Search for emails about invoices with attachments" | Matching messages only; attachments listed by name/size. |
| "Read the newest unread email" | Full headers and text body. Afterwards the message is **still unread**. |
| "Show me the whole thread for that email" | The conversation's messages in order. |

## 4. Negative checks (optional)
- `/mcp` with no token returns **401** with `WWW-Authenticate: Bearer resource_metadata="…", scope="mail.read"`; a wrong or expired token also returns 401.
- Clicking **Deny** on the consent screen returns `access_denied` to the client and connects nothing.
- More than 60 requests a minute on one key or connection returns **429**.
- Disconnecting the app or revoking the key → the connector stops working (401).
- Asking it to delete, move, or flag mail: there is no tool for that. Asking it to send without you turning sending on, or without confirming the email, does not send.

## Tools and annotations
Read tools: `readOnlyHint: true`, `destructiveHint: false`, `idempotentHint: true`, `openWorldHint: false`. `send_message`: `readOnlyHint: false`, `destructiveHint: true`, `idempotentHint: false`, `openWorldHint: true`.

| Tool | Title | Classification |
|---|---|---|
| `list_accounts` | List accounts | Read |
| `list_folders` | List folders | Read |
| `search_messages` | Search messages | Read |
| `read_message` | Read message | Read |
| `read_thread` | Read thread | Read |
| `send_message` | Send email | Write. The demo mailbox can send; mail stays on the isolated demo server. |

## What it does not do
It does not delete, move, flag, or mark mail as read. It does not send from a mailbox where sending is off, or through a connection that was not allowed to send. Mail content is not stored. Email content is returned marked as untrusted third-party content.
