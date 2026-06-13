# roboport

## 0.4.0

### Minor Changes

- [#60](https://github.com/Destiner/roboport/pull/60) [`27df797`](https://github.com/Destiner/roboport/commit/27df7970e1fa598ce29ac19c9af96aa8a4c3b0aa) Thanks [@Destiner](https://github.com/Destiner)! - Add `Github` and `Slack` MCP client presets to `roboport/mcp`. `Github` wraps the hosted GitHub MCP server with a personal access token (with optional `toolsets` and `readOnly` scoping); `Slack` exposes a curated set of Slack Web API tools (post message, reply in thread, list channels, channel history, users, reactions) via a bot token.

## 0.3.0

### Minor Changes

- [#58](https://github.com/Destiner/roboport/pull/58) [`1cfae89`](https://github.com/Destiner/roboport/commit/1cfae89a2a0f8b9712741de8d0204edaf752e721) Thanks [@Destiner](https://github.com/Destiner)! - Rename model adapter classes to drop the `Model` suffix: `AnthropicModel` → `Anthropic`, `OpenAIModel` → `OpenAI`, `GeminiModel` → `Gemini`, `MoonshotModel` → `Moonshot`, and `OpenAICompatibleModel` → `OpenAICompatible`. Update imports from `roboport/models` accordingly.

## 0.2.0

### Minor Changes

- [#55](https://github.com/Destiner/roboport/pull/55) [`01368b0`](https://github.com/Destiner/roboport/commit/01368b0a5b4cb950b4eb5f0f5954ae33044c2826) Thanks [@Destiner](https://github.com/Destiner)! - Export the `Mcp` client, transport config types, and auth providers (`BearerAuth`, `OAuthAuth`, `AuthProvider`, plus OAuth storage helpers) from `roboport/mcp`, so consumers can connect MCP servers that don't have a built-in preset.

  `OAuthAuth` now accepts a pre-registered `clientId` for servers without dynamic client registration, and `Mcp` validates its `name` at construction (it becomes part of each tool name) instead of failing later at model-request time.

## 0.1.0

### Minor Changes

- [#52](https://github.com/Destiner/roboport/pull/52) [`9f1fbba`](https://github.com/Destiner/roboport/commit/9f1fbbad454ceb39b929637828128bc0f6ca4542) Thanks [@Destiner](https://github.com/Destiner)! - Add **gateways**: a bidirectional connection between a chat transport and an agent. Ships the `roboport/gateways` subpath with the `Gateway`/`Channel` primitive, `serve(agent, gateway, options)` (per-conversation sessions, serialization, presence, durable history), `telegramGateway` (webhook + long-polling) with a streaming `stream()` relay, and `memoryStore`/`fileStore`. Adds `agent.session({ systemExtension })` to append per-turn instructions to the system prompt.
