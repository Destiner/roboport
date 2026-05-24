---
name: public-docs
description: Writes and maintains external, user-facing docs for an SDK / API / product, run from a docs repo with upstream source repos as context. Classifies each page as quickstart / concept / how-to / reference / recipe, prefers generated shape with hand-written meaning, and avoids duplication with the SDK README. Use when working in a docs repo (Mintlify, Docusaurus, or plain markdown) or when the user asks to write or refresh public/user-facing docs.
---

# Public docs

Write and maintain external, user-facing docs for an SDK, API, or product. This skill runs from a docs repo and treats upstream code repos (SDK source, backend, OpenAPI spec) as context.

Out of scope: the docs repo's own internal README / `AGENTS.md`, changelogs, marketing copy.

## First, orient

Three things to discover before writing anything:

1. **Output format.** Inspect the repo root:
   - `docs.json` / `mint.json` → Mintlify (MDX).
   - `docusaurus.config.*` → Docusaurus (MDX).
   - Otherwise → plain Markdown.
2. **Upstream source.** Where does the truth live? Look for `.upstream-refs.json`, a `package.json` `repository` field, or a CONTRIBUTING note. If none, ask once and record the answer.
3. **Existing pages on the same topic.** Grep the docs tree before drafting. Update > duplicate.

## Doc types — classify before drafting

Each page is *one* of these. Mixing modes is the most common cause of bad docs.

| Type | Reader posture | Contains | Does not contain |
|---|---|---|---|
| Quickstart | Skim & copy | Prereqs, install, auth, one runnable request, expected response, next-step links | Concepts, full param tables, alternatives |
| Concept | Sit & read | Mental model, terms defined once, "how it fits" | Code, step-by-step, exhaustive params |
| How-to | Scan for step | Goal, prereqs, numbered steps, verification, troubleshooting | Theory, tangential alternatives |
| Reference (API / SDK) | Ctrl-F | Signature or method+path, every param (type, required, default, description), example, response shapes, errors | Tutorials, opinion |
| Recipe | Steal & adapt | Full runnable file, what to change | Production caveats stacked at the end |

Heading is the question the reader asked, not the noun. "How to rotate keys", not "Key rotation".

## Voice

- Second person, active, present tense. *"Create a key"*, not *"A key is created"*.
- One term per concept, used everywhere. Pick "API key" or "API token", not both.
- Open with the verb. No "Welcome to…", "We're excited to…", "Simply…", "Note that…".
- Banned adjectives: *powerful, robust, seamless, magical, blazing-fast, simply*. If a sentence reads like marketing, cut it.

## Mintlify MDX components

Use sparingly. Plain markdown beats a component that adds no information.

| Component | Use for | Avoid for |
|---|---|---|
| `<CodeGroup>` | Same task in multiple languages | A single snippet |
| `<Steps>` | Ordered, irreversible procedures | Tips, "best practices" |
| `<Tabs>` | Same code across runtimes (Node / Deno / Bun) | Different concepts side-by-side |
| `<Cards>` | Hub or landing pages | Mid-flow navigation |
| `<ParamField>` / `<ResponseField>` | Reference param tables | Concept pages |
| `<Note>` / `<Warning>` | Genuine constraint or footgun, at most one per page | Praise, sales tone, padding |
| `<Accordion>` | Genuinely optional depth | Hiding required reading |

## Generate the shape, hand-write the meaning

| Surface | Approach |
|---|---|
| REST endpoints | Generate the reference from OpenAPI. Hand-write the intro paragraph and examples. |
| TypeScript SDK | Generate signatures from `tsc --declaration` or TypeDoc. Hand-write usage and concept links. |
| Webhooks, errors | Hand-write, cross-checked against a source-of-truth enum or schema. |
| Quickstart, concept, how-to | Always hand-write. |

Generated content with no prose around it reads like `--help`. Don't ship it.

## Cross-links to upstream code

- Default: link to the SDK's *own published docs page*, not its source.
- When pointing at an implementation detail, link a permalink at a commit SHA — never `main`. `main` links rot silently.
- Never paste upstream source into a docs page. Snapshot drift > linking cost.

## Avoid duplication with the SDK README

The README owns: *what is it*, one runnable example, link to the docs. Nothing else.

The docs own: quickstart, concepts, references, how-tos.

If a section appears in both, the docs are canonical and the README links to them. Propose collapsing duplicates when you find them.

## Detecting staleness

Cheap pass before writing:

- For pages with `<ParamField>` / `<ResponseField>` / fenced code calling SDK symbols → fetch the upstream file at the latest tagged release and check the symbols still exist.
- For OpenAPI-driven references → compare the spec hash in the docs repo to the upstream spec. If they diverge, the reference is stale.
- Backticked commands and config keys → verify they still appear in the upstream README or source.

Anything quoted in the docs that the upstream invalidates is a must-fix.

## Output

For each page touched:

- State the doc type and whether it's a new page or an edit.
- One-line reason tied to the upstream change (or to the user's request).
- Apply via `Edit` for changes, `Write` for new pages.

After edits, run the docs repo's check (`mintlify dev`, `docusaurus build`, or repo-specific) to catch broken MDX and link rot.
