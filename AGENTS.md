# roboport

Minimal TypeScript framework for building LLM agents.

## Commands

- `bun install` - Install dependencies
- `bun run check` - Prettier + ESLint
- `bun run typecheck`
- `bun --filter roboport build` - Build the framework package into `dist`
- `bun --filter roboport test` - Run the framework package unit tests
- `bun run docs` - Start the docs site
- `bun run changeset` - Add a Changesets entry for user-facing package changes
- `bun run release` - Build and publish `packages/roboport/dist` (Release workflow)

## Stack

- TypeScript 6
- Runtime: Bun
- Schemas: Zod 4
- Lint: ESLint

## Structure

Bun workspaces monorepo. `packages/*` hold libraries; `apps/*` hold runnable services.

- `packages/roboport/` - the framework package (`name: "roboport"`); workspace consumers import `src` directly, `bun --filter roboport dist:pack` builds and tarballs `dist/` with its own manifest (the standard `bun pm pack` from this directory packs `src` and is not the supported flow); subpath exports for `gateways`, `harness`, `mcp`, `models`, `skills`, `triggers`
  - `src/core/` - Agent loop and `Tool` / `Skill` / `Agent` / `Session` primitives, plus provider-agnostic message and stream event types
  - `src/models/` - `Model` adapters (Anthropic, Google, Moonshot, OpenAI, OpenAI-compatible); OpenAI Codex auth lives in `openai-codex-auth.ts`
  - `src/mcp/` - MCP client; transports in `core.ts`, auth in `auth.ts` / `oauth.ts`, server presets in `clients/`
  - `src/gateways/` - Gateway primitive and `serve` runtime for bidirectional chat transports; includes Telegram polling/webhook support and memory/file conversation stores
  - `src/harness/` - `Harness` bundle, Claude Code/Codex/Pi presets, and standalone, reusable tools in `tools.ts` (`web_search`, `web_fetch`, plus neutral `read_file` / `write_file` / `edit_file` / `bash` that delegate to the `shared.ts` helpers)
  - `src/skills/` - Opt-in skill bundle (`pr-review`, `docs-update`, `public-docs`, `developer-experience`, `code-simplifier`); each skill is a `<name>/SKILL.md` with YAML frontmatter (`name`, `description`); `src/skills/index.ts` imports the raw text and parses each into a `Skill` instance
  - `src/triggers/` - Trigger primitive (`cron`, GitHub/Grafana/Linear/Telegram webhook receivers, plus the Telegram Bot API client); GitHub supports pull request, pull request review comment, issue comment, issues, and push events
  - `examples/` - Standalone usage examples
- `apps/bot/` - Webhook-driven runner. Hono server mounts `GithubReceiver` at `POST /webhooks/github`, dispatches `pr-review`, `docs-update`, `simplify`, and `dx-audit` workflows for actionable PR and review-comment events, and opens advisory GitHub check runs for PR workflows. Deployed to Railway via `apps/bot/Dockerfile`; codex auth/refresh tokens persist on a mounted volume.
- `apps/docs/` - Vocs docs site (`name: "@roboport/docs"`).

## Patterns

- Tools accept either a Zod `inputSchema` or a raw `jsonSchema`; the `Tool` constructor has overloads for both (`packages/roboport/src/core/tool.ts`).
- `roboport` keeps Zod as a peer dependency, so workspace consumers that define Zod-backed tools list `zod` in their own dependencies (`packages/roboport/package.json`).
- Deferred tools (`deferred: true`) are surfaced to the model via a `ToolSearch`-style flow; the loop reads them from the registry in `packages/roboport/src/core/tool.ts`.
- Agents and sessions can set `cwd` to scope a run to a workspace, and `agent.session({ systemExtension })` appends per-session instructions to the system prompt; built-in harness shell/search tools default to `ToolContext.cwd` (`packages/roboport/src/core/agent.ts`, `packages/roboport/src/core/tool.ts`).
- Trigger handlers registered with `Agent.on` receive the event and call `agent.session().send(...)` when they want to run the agent (`packages/roboport/src/core/agent.ts`).
- The root `roboport` export re-exports core primitives and message/session/tool registry types from `packages/roboport/src/core/` (`packages/roboport/src/index.ts`).
- Every `Model` adapter extends the abstract class in `packages/roboport/src/core/model.ts`, implements `streamMessage(...)`, and converts to/from the wire format internally, including provider-specific `ThinkingLevel` mappings; Anthropic Opus 4.7 and later use adaptive thinking instead of budget tokens.

## Conventions

- Conventional commits (`feat:`, `fix:`, `chore:`, `docs:`, `refactor:`).
- Add a changeset for user-facing changes to `roboport`; `.changeset/config.json` ignores `@roboport/bot` and `@roboport/docs`.
- Run `bun run check && bun run typecheck` before committing.
