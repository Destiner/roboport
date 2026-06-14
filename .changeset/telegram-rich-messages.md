---
'roboport': minor
---

The Telegram gateway now sends replies as rich messages instead of plain text.
Reply text is treated as GitHub-Flavored Markdown and rendered by Telegram
clients with headings, lists, tables, blockquotes, fenced code blocks, math, and
collapsible blocks, so an agent's Markdown output is formatted rather than shown
as literal `**` and backticks. `TelegramClient` gains `sendRichMessage` and
`sendRichMessageDraft` (plus the `RichMessage` content type); `channel.send` /
`channel.draft` and the `stream` relay route through them, and drafts now allow
up to 32768 characters.

Note: this changes outbound formatting for existing Telegram bots and requires a
Bot API version with rich message support. Rich drafts are private-chat only.
