---
'roboport': minor
---

Carry the replied-to message through to inbound channel messages. `InboundMessage.replyToId` is replaced by `replyTo`, a `ReplyContext` with the parent message's `id`, `text`, `user`, whether it was the agent's own message (`isBot`), and the fragment the sender highlighted (`quote`) — Telegram delivers the parent inline, so nothing is looked up. The Telegram channel now types its inbound messages as `TelegramInboundMessage`, narrowing `raw` to `TelegramMessage` across serve's seams. `serve`'s default prompt is still `message.text`; use the `prompt` seam to fold the reply into what the agent sees.
