# Docs update

Keep a repo's *internal* docs (`README.md`, `AGENTS.md` / `CLAUDE.md`, `docs/**/*.md`) in sync with a code change. Surgical edits, one canonical home per fact, matched voice.

Out of scope: public/user-facing docs sites (Mintlify, Docusaurus, API reference), changelogs, release notes. Use other skills for those.

## When this runs

After a PR-sized change set lands or is about to. Skip for:

- Typo / formatting / comment-only changes.
- Internal refactors with no change to public API, CLI, config, env vars, scripts, or directory layout.
- Dependency bumps that don't change usage.
- Test-only changes.

If unsure whether a change is doc-worthy, default to *no edit*. Drift is cheaper than slop.

## Inputs

Read once, hold in memory:

- The diff: `git diff <base>..HEAD --name-only` and `git diff <base>..HEAD` (or the staged diff if pre-commit).
- The docs in scope: `README.md`, `AGENTS.md` / `CLAUDE.md`, and `docs/**/*.md`.

Do not pre-read source files. Open them only to verify a specific claim.

## Routing — one fact, one home

| Fact type | Lives in |
|---|---|
| Consumer-facing usage, install, status | `README.md` |
| Build/test/lint commands, conventions, gotchas, project structure | `AGENTS.md` |
| Multi-page how-to, architecture, ADRs | `docs/<topic>.md` |

When a fact lands in the diff:

1. Look for an existing doc that already covers the topic — edit there.
2. If none, place it in the *narrowest* home: a bullet in `AGENTS.md` before a new `docs/` page; a new `docs/` page before expanding `README.md`.
3. Never duplicate. If a fact must be referenced from multiple docs, write it once and link.

## Staleness detection

Cheap pass: scan each doc for code-shaped tokens, verify they still resolve.

- Backticked commands → still in `package.json` scripts / `Makefile` / on `PATH`?
- `file:line` and `path/to/x` references → file still exists, line still relevant?
- Named exports, types, CLI flags, env vars, config keys → still present?
- Stack / runtime / version claims → match `package.json`, lockfile, `engines`?
- Module-tree descriptions → match the actual `src/` layout?

Anything quoted in a doc that the diff invalidates is a *must-fix*. Add new facts only when the diff introduces something a reader would expect to find documented and currently can't.

## Voice preservation

Before editing a doc, sample its existing tone — sentence length, hedging, capitalization, list style. Match it. Edit with `Edit` (string replacement), not full rewrites; a one-line change should touch one line.

Words to avoid introducing: *comprehensive*, *robust*, *seamlessly*, *leverage*, *in order to*, *cutting-edge*. If a phrase reads like marketing or like an LLM wrote it, rewrite it in the doc's own voice or leave it out.

## AGENTS.md specifically

- Keep under ~50 lines. If a topic outgrows that, move to `docs/<topic>.md` and link.
- Prefer `file:line` references over inline code snippets — snippets rot.
- Omit anything a linter or formatter already enforces.
- No badges, no ToC, no "Why this project?".

## Output

For each proposed change, state:

- The file.
- A one-line reason tied to the diff (e.g. "renamed `Tool.handler` → `Tool.execute` (src/core.ts:100)").
- The edit, applied via `Edit`.

After applying edits, run the repo's check command (often `bun run check` or equivalent) to catch broken refs in fenced code blocks.

If no edits are warranted, say so in one line and stop.
