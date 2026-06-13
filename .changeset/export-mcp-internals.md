---
'roboport': minor
---

Export the `Mcp` client, transport config types, and auth providers (`BearerAuth`, `OAuthAuth`, `AuthProvider`, plus OAuth storage helpers) from `roboport/mcp`, so consumers can connect MCP servers that don't have a built-in preset.

`OAuthAuth` now accepts a pre-registered `clientId` for servers without dynamic client registration, and `Mcp` validates its `name` at construction (it becomes part of each tool name) instead of failing later at model-request time.
