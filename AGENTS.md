# drone

Minimal TypeScript framework for building LLM agents.

## Commands

- `bun install` - Install dependencies
- `bun run check` - Prettier + ESLint
- `bun run typecheck`

No test suite yet.

## Stack

- TypeScript 6
- Runtime: Bun
- Schemas: Zod 4
- Lint: ESLint

## Structure

- `src/core/` - Agent loop and `Tool` / `Skill` / `Agent` primitives, plus provider-agnostic message types
- `src/models/` - `Model` adapters (Anthropic, OpenAI, OpenAI-compatible, Moonshot)
- `src/mcp/` - MCP client; transports in `core.ts`, auth in `auth.ts` / `oauth.ts`, server presets in `clients/`
- `src/harness/` - `Harness` bundle and Claude Code preset
- `src/skills/` - Opt-in skill bundle (`pr-review`, `docs-update`, `public-docs`, `developer-experience`, `code-simplifier`); each skill is a `<name>/SKILL.md` with YAML frontmatter (`name`, `description`); `src/skills/index.ts` imports the raw text and parses each into a `Skill` instance
- `.github/workflows/` + `scripts/` - PR automation; `docs-update.yaml` runs `scripts/docs-update.ts` to sync internal docs and commit with `[skip ci]`

## Patterns

- Tools accept either a Zod `inputSchema` or a raw `jsonSchema`; the `Tool` constructor has overloads for both (`src/core/tool.ts:90`).
- Deferred tools (`deferred: true`) are surfaced to the model via a `ToolSearch`-style flow; the loop reads them from the registry in `src/core/tool.ts:124`.
- Every `Model` adapter extends the abstract class in `src/core/model.ts:13` and converts to/from the wire format internally.

## Conventions

- Conventional commits (`feat:`, `fix:`, `chore:`, `docs:`, `refactor:`).
- Run `bun run check && bun run typecheck` before committing.
