---
'roboport': minor
---

Rename the `gateways` concept to `channels`. The `roboport/gateways` subpath is now `roboport/channels`, `telegramGateway` is `telegramChannel`, and the `Gateway`/`Channel` pair is renamed to `Channel`/`Conversation` (`GatewayHandler` → `ChannelHandler`, `GatewayRuntime` → `ChannelRuntime`, `TelegramGateway` → `TelegramChannel`, `TelegramGatewayOptions` → `TelegramChannelOptions`, the per-conversation reply handle `TelegramChannel` → `TelegramConversation`).
