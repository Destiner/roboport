---
name: developer-experience
description: Reviews an SDK or API repo as a linter for developer experience and agent experience (AX). Surfaces papercuts: friction, inconsistent naming, unidiomatic REST, weak errors, untyped boundaries, and patterns that make the surface hard for LLM-driven agents to consume. Use when the user asks to audit an SDK / API for DX, AX, ergonomics, or how it feels to use.
---

# Developer experience

Review an SDK or API repo as a *linter for developer experience*. Surface papercuts — friction (the user had to know something undocumented to succeed) and inconsistency (the same concept named, shaped, or behaved-with two different ways). Equally evaluates **agent experience** (AX): how easily an LLM-driven agent can use the surface.

This skill runs on a *whole repo*, not a diff. Out of scope: refactoring the code, writing user-facing docs, reviewing a single diff.

## How to make a whole-repo review tractable

Three passes. Without them the review drowns.

1. **Surface map.** Enumerate the public surface only: exported endpoints (router files, OpenAPI), exported SDK symbols (`index.ts`, `package.json#exports`), error classes, README's quickstart. Skip internals.
2. **Sample.** Pick 3–5 representative resources / endpoints / tools and review them deeply against the dimensions below. The goal is *patterns*, not coverage.
3. **Cross-cut.** For each finding, ask: is this a one-off or repo-wide? Repo-wide drift outranks a single offender.

Result: review cost is O(surface), not O(LOC).

## The citation rule

Every finding must cite either:

- A public reference — Stripe error docs, Google AIP, Microsoft REST guidelines, JSON:API §, Anthropic's "Writing tools for agents", RFC 9457, etc. *or*
- The repo's own internal inconsistency — endpoint A does X, endpoint B does Y.

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
- Single-occurrence naming nits when the repo convention is otherwise consistent.

## Output

Markdown, sections optional — omit any that's empty:

```
## Papercuts (blocking)
- <statement>. `src/path.ts:42` — <why it hurts, citing rule or repo inconsistency>

## Worth addressing
- ...

## Nits / consistency drift
- ...

## Agent-experience notes
- <AX-specific findings, separated because the fix audience may differ>
```

End with one line — a verdict. One of: `Idiomatic`, `Idiomatic with rough edges`, `Needs work`, `Hostile to agents`.

No numeric scores. No praise section. Every finding cites a file/line or a public reference.
