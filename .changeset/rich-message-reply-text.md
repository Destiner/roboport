---
'roboport': patch
---

Recover the text of a replied-to rich message. A message sent with `sendRichMessage` carries no `text` — its content is a block tree under `rich_message` — so `replyTo.text` was empty whenever a user replied to one of the agent's own replies, which is the common case. `TelegramMessage` now models `rich_message`, and the new `richMessageText` helper (exported from `roboport/triggers`) flattens the block tree into plain text.
