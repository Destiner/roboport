---
name: developer-experience
description: Reviews a software surface — a whole repo, an SDK/API, a diff or PR, a single commit, a single file, or a design proposal — as a linter for developer experience (DX) and agent experience (AX). Surfaces papercuts: friction, inconsistent naming, unidiomatic REST, weak errors, untyped boundaries, and patterns that make the surface hard for LLM-driven agents to consume. Use when the user asks to audit DX, AX, ergonomics, or how a surface feels to use, at any scope.
---

# Developer experience

Review a software surface as a *linter for developer experience*. Surface papercuts — friction (the user had to know something undocumented to succeed) and inconsistency (the same concept named, shaped, or behaved-with two different ways). Equally evaluates **agent experience** (AX): how easily an LLM-driven agent can use the surface.

Out of scope: refactoring the code, writing user-facing docs.

## Scope

This skill adapts to the *surface area* under review. Decide it from what you were asked:

- **Whole repo / SDK / API** — the full public surface.
- **A diff or PR** — only the surface the change adds, removes, or alters, plus its immediate blast radius.
- **A single commit** — the surface that commit touches.
- **A single file or module** — the public surface that file exposes.
- **A proposal / RFC / design doc** — the surface as *described*; there is no code to read yet.
- Ambiguous → ask which.

The dimensions, the citation rule, and the what-not-to-flag list below are identical at every scope. Only *what you read* and *how you bound the review* change.

## How to make the review tractable

Match the method to the scope. Three passes keep any scope from drowning:

1. **Map the surface.** Enumerate the public surface only — skip internals.
   - Repo / SDK / API: exported endpoints (router files, OpenAPI), exported symbols (`index.ts`, `package.json#exports`), error classes, the README quickstart.
   - Diff / commit: only the public symbols the change adds, removes, or alters.
   - File: the symbols that file exports.
   - Proposal: the surface the document describes.
2. **Sample.** For a large surface, pick 3–5 representative resources / endpoints / tools and review them deeply against the dimensions below. The goal is *patterns*, not coverage. For a diff-sized or single-file surface, review all of it.
3. **Place each finding.** Ask: is this **local** (this one symbol) or **systemic** (a pattern across the surface, or drift the change introduces against an existing convention)? Systemic outranks local.

Result: review cost is O(surface under review), not O(LOC).

## The citation rule

Every finding must cite either:

- A public reference — Stripe error docs, Google AIP, Microsoft REST guidelines, JSON:API §, Anthropic's "Writing tools for agents", RFC 9457, etc. *or*
- The surface's own internal inconsistency — endpoint A does X, endpoint B does Y.

If neither applies, drop it. "I would have…" is not a citation. This is the single biggest guardrail against taste-creep.

## DX dimensions

Roughly in priority order. Lenses, not a checklist:

1. **Consistency of shapes & naming** — case (snake vs camel), plurality, ID format, response envelope. Compounds across every endpoint.
2. **Error design** — structured object with stable `code`, human `message`, `documentation_url`, optional `param` / `pointer`. No leaking stack traces.
3. **Authentication & onboarding** — time-to-first-200, key creation friction, scopes, rotation.
4. **Resource modeling** — nouns, plural collections, hierarchy depth ≤ 1, list vs item endpoints.
5. **Pagination, filtering, sorting** — one mechanism repo-wide; cursors stable and opaque; documented defaults and caps.
6. **Versioning & deprecation** — explicit policy; deprecation visible in *both* the response and the docs.
7. **Idempotency & safe retries** — keys on writes, documented replay window, retriable-vs-not made explicit.
8. **Type safety on the SDK boundary** — no `any`, generics that infer, discriminated result types, branded nominal IDs, no stringly-typed enums.
9. **Docs you can copy-paste** — runnable examples, env-var conventions, every parameter documented incl. enum values.
10. **Observability hooks** — request IDs in responses and errors, webhook signatures.
11. **Defaults & footguns** — sane defaults, no silent truncation or coercion.
12. **Long-running operations** — one documented pattern (operation polling, webhook, async job), not three.

## AX dimensions

Where DX and AX diverge. These are the concrete checks defensible today — skip speculation about "what agents would prefer".

1. **Machine-readable spec exists and is current.** OpenAPI / TypeSpec / GraphQL SDL / Smithy committed; generated SDKs match.
2. **Errors are programmatically branchable.** `code` is a stable enum, not free-text. `is_retriable` / `retry_after` present where meaningful.
3. **Non-interactive auth path.** API key or client-credentials works headlessly — no mandatory browser, CAPTCHA, or MFA on the agent path.
4. **Token-efficient responses.** Lists paginate. Field selection or `expand` supported. Default payload doesn't dump internal UUIDs and base64 blobs.
5. **Self-contained tool/endpoint descriptions.** Every parameter described, enum values listed, "what happens when omitted" stated.
6. **Predictable schemas.** Same request, same response shape. No flags that silently change return type.
7. **Stable docs URL or `llms.txt`.** Deprecation flagged in the *spec*, not only in HTML.
8. **Namespacing & discoverability.** Tools/endpoints grouped by resource with consistent prefixes.

## What not to flag

- Stylistic taste with no concrete cost ("would be more elegant as…").
- Linter / formatter territory (semicolons, import order, prettier output).
- Performance speculation without a measurement.
- Protocol religion (REST vs GraphQL vs gRPC).
- Choices a framework forces.
- Single-occurrence naming nits when the convention is otherwise consistent.
- When the scope is a diff or commit: pre-existing papercuts outside the surface the change touches — note systemic drift the change *introduces*, not debt it merely sits next to.

## Output

Markdown, sections optional — omit any that's empty:

```
## Papercuts (blocking)
- <statement>. `src/path.ts:42` — <why it hurts, citing rule or surface inconsistency>

## Worth addressing
- ...

## Nits / consistency drift
- ...

## Agent-experience notes
- <AX-specific findings, separated because the fix audience may differ>
```

End with one line — a verdict on the surface under review. One of: `Idiomatic`, `Idiomatic with rough edges`, `Needs work`, `Hostile to agents`. When reviewing a proposal, frame each finding against the surface it *would* create and phrase the verdict accordingly.

No numeric scores. No praise section. Every finding cites a file/line (or, for a proposal, the section it refers to) or a public reference.
