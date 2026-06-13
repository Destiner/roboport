# roboport

## 0.1.0

### Minor Changes

- [#52](https://github.com/Destiner/roboport/pull/52) [`9f1fbba`](https://github.com/Destiner/roboport/commit/9f1fbbad454ceb39b929637828128bc0f6ca4542) Thanks [@Destiner](https://github.com/Destiner)! - Add **gateways**: a bidirectional connection between a chat transport and an agent. Ships the `roboport/gateways` subpath with the `Gateway`/`Channel` primitive, `serve(agent, gateway, options)` (per-conversation sessions, serialization, presence, durable history), `telegramGateway` (webhook + long-polling) with a streaming `stream()` relay, and `memoryStore`/`fileStore`. Adds `agent.session({ systemExtension })` to append per-turn instructions to the system prompt.
