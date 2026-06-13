# roboport

Minimal TypeScript framework for building LLM agents.

## Install

```sh
bun add roboport zod
```

`zod` is a peer dependency, declare it in your own dependencies when you define
Zod-backed tools.

## Exports

- `roboport` — agent loop and core `Tool` / `Skill` / `Agent` / `Session` primitives
- `roboport/models` — `Model` adapters (Anthropic, Google, Moonshot, OpenAI, OpenAI-compatible)
- `roboport/mcp` — MCP client (transports, auth, server presets)
- `roboport/harness` — `Harness` bundle and standalone, reusable tools
- `roboport/skills` — opt-in skill bundle
- `roboport/triggers` — trigger primitive (cron + GitHub/Grafana/Linear/Telegram receivers)

## Docs

See [github.com/Destiner/roboport](https://github.com/Destiner/roboport).
