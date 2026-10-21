# OpenMail — reviewer testing guide

OpenMail is a remote MCP server (`https://mcp.openmail.tools/mcp`) that lets Grok Bot read and search IMAP mailboxes. Auth is a static bearer API key (`Authorization: Bearer <key>`) created in the OpenMail web app. All tools are read-only.

## 1. Sign in
- Go to https://mcp.openmail.tools and sign in as **reviewer@openmail.tools**. The password is provided separately by the developer (contact webumer@gmail.com if you did not receive it).

## 2. Mailbox
- **Demo mailbox (preferred):** a demo mailbox with sample messages is already added to the reviewer account. Nothing to do.
- **Or add your own:** Dashboard → *Add mailbox* → choose a preset (Migadu, Fastmail, Zoho, iCloud) or *Custom* (IMAP host, port 993 SSL/TLS) → username + password (an app password for Gmail/iCloud/Fastmail/Zoho) → *Test connection* → *Save*. Passwords are encrypted at rest and never shown again.

## 3. API key
- Dashboard → *API keys* → *Create key*. Copy it now; it is shown only once. You can revoke it afterwards.

## 4. Connect in Grok Bot
- Install OpenMail from the marketplace (or add a custom MCP server with URL `https://mcp.openmail.tools/mcp` and header `Authorization: Bearer <key>`), and paste the key.

## 5. Prompts and expected results

| Prompt | Expected |
|---|---|
| "List my OpenMail accounts" | The demo (or your) mailbox: address, provider, host. No password anywhere. |
| "What folders are in my mailbox and how many unread?" | Folder list (INBOX, Sent, …) with total/unread counts. |
| "Find unread emails from this week" | Newest-first list with sender, subject, date, attachment flag. |
| "Search for emails about invoices with attachments" | Matching messages only; attachments listed by name/size. |
| "Read the newest unread email" | Full headers and text body. Afterwards the message is **still unread** (check in any mail client or ask for unread count again). |
| "Show me the whole thread for that email" | The conversation's messages in order. |

## 6. Negative checks (optional)
- Calling the endpoint with no key or a wrong key returns **401**.
- More than 60 requests a minute on one key returns **429**.
- Revoke the key in the dashboard → the connector stops working (401).

## What it does not do (by design, today)
No sending, deleting, moving, flagging or marking as read. Mail is not stored by OpenMail. Sending (draft first, sent only after explicit user approval) is planned.
