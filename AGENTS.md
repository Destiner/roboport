# drone

Minimal TypeScript framework for building LLM agents.

## Commands

- `bun install` - Install dependencies
- `bun run start` - Run `src/index.ts`
- `bun run dev` - Hot-reload entry
- `bun run lint` - Prettier + ESLint (use `bunx eslint --fix` for auto-fix)
- `bun run typecheck` - `tsc --noEmit`

No test suite yet.

## Stack

- TypeScript 6 (strict, `moduleResolution: bundler`, `erasableSyntaxOnly`)
- Runtime: Bun
- Schemas: Zod 4
- Lint: ESLint 10 + typescript-eslint + eslint-plugin-import-x

## Structure

- `src/core.ts` - Agent loop and `Tool` / `Skill` / `Agent` primitives
- `src/message.ts` - Provider-agnostic message types
- `src/models/` - `Model` adapters (Anthropic, OpenAI, OpenAI-compatible, Moonshot)
- `src/mcp/` - MCP client; transports in `core.ts`, auth in `auth.ts` / `oauth.ts`, server presets in `clients/`
- `src/harness/` - `Harness` bundle and Claude Code preset

## Patterns

- Path alias `@/*` → `src/*` (see `tsconfig.json`).
- `import-x/prefer-default-export` is enforced. Single-export files use `export default`; barrel `index.ts` files re-export named symbols. Suppress inline when unavoidable — see `src/harness/core.ts:13`.
- Tools accept either a Zod `inputSchema` or a raw `jsonSchema`; the `Tool` constructor has overloads for both (`src/core.ts:95`).
- Deferred tools (`deferred: true`) are surfaced to the model via a `ToolSearch`-style flow; the loop reads them from the registry in `src/core.ts:188`.
- Every `Model` adapter extends the abstract class in `src/core.ts` and converts to/from the wire format internally.

## Conventions

- Conventional commits (`feat:`, `fix:`, `chore:`, `docs:`, `refactor:`).
- Run `bun run lint && bun run typecheck` before committing.
