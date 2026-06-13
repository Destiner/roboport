---
'roboport': minor
---

Add **gateways**: a bidirectional connection between a chat transport and an agent. Ships the `roboport/gateways` subpath with the `Gateway`/`Channel` primitive, `serve(agent, gateway, options)` (per-conversation sessions, serialization, presence, durable history), `telegramGateway` (webhook + long-polling) with a streaming `stream()` relay, and `memoryStore`/`fileStore`. Adds `agent.session({ systemExtension })` to append per-turn instructions to the system prompt.
