# drone

A small TypeScript framework for building LLM agents. Composable primitives — `Agent`, `Model`, `Tool`, `Skill` — with first-class MCP and pluggable model providers (Anthropic, OpenAI, OpenAI-compatible, Moonshot).

```ts
import { Agent } from '@/core';
import { AnthropicModel } from '@/models';
import { linearMcp } from '@/mcp';

const agent = new Agent({
  model: new AnthropicModel('claude-sonnet-4-6'),
  prompt: 'You are a Linear assistant.',
  tools: [],
  skills: [],
  mcp: [linearMcp({ apiKey: process.env.LINEAR_API_KEY! })],
});

const { messages } = await agent.createSession({
  prompt: 'List open issues assigned to me.',
});
```

## Layout

- `src/core.ts` — agent loop, `Tool` / `Skill` / `Agent` primitives, deferred-tool registry
- `src/message.ts` — provider-agnostic message types
- `src/models/` — `Model` adapters
- `src/mcp/` — MCP client (HTTP + stdio, Bearer + OAuth)
- `src/harness/` — `Harness` bundle and Claude Code preset
- `src/skills/` — skill bundles

## Scripts

```sh
bun install
bun run start      # run src/index.ts
bun run dev        # hot-reload
bun run lint
bun run typecheck
```

Requires [Bun](https://bun.sh).

## Status

Early. APIs will change.
