---
name: pr-review
description: Reviews a pull request or branch diff and produces a short, severity-tiered report (must-fix / should-consider / nits) with a final verdict. Use when the user asks to review a PR, review their branch, look at someone else's PR, or mentions a PR number / URL.
---

# PR review

Review a pull request or branch diff for blocking issues before it merges. The output is a short, severity-tiered report — not a checklist run.

## Scope

Three sources. Pick by what the user said:

- A PR number, PR URL, or `#NNN` → remote PR. Use `gh pr view <id> --json title,body,baseRefName,headRefName,author` for context and `gh pr diff <id>` for the patch.
- "review my branch", "review this branch" → local diff. Base is `git merge-base HEAD origin/<default-branch>`. Use `git diff <base>...HEAD` for the patch and `git log <base>..HEAD --oneline` for intent.
- Ambiguous → ask which one.

Skip drafts, lockfiles, and generated files unless explicitly asked.

## Context

Load just enough to ground judgement:

- Any `AGENTS.md` / `CLAUDE.md` in the changed files' directory ancestry. These are the source of truth for project conventions.
- PR title + description, or branch commit messages — to know the *intent* before reading the patch.

Do not pre-read the whole repo. Open files as questions arise during the scan.

Do not run the project's lint, typecheck, or test commands. CI already runs them on the same diff, and their output is not more informative than the diff itself.

## Reading the diff

Three passes. Single-pass review misses things and over-flags.

1. **Skim.** Summarise the change in one line. Decide if review is warranted. Drafts, pure renames, dep bumps without lockfile changes, mechanical refactors: say so and stop.
2. **Scan.** Walk the diff hunk by hunk. Weigh each hunk against the dimensions below. Note *candidate* findings; do not yet decide what to report.
3. **Validate.** For every candidate, ask: can I quote the rule it breaks, the input that makes it fail, or the convention in `AGENTS.md` it violates? If not, drop it. False positives erode trust faster than missed positives.

## Dimensions

In rough priority order — these are lenses, not a checklist:

1. **Correctness** — logic, off-by-one, null/empty, error paths, async/race.
2. **Security** — injection, authz, secrets, deserialization, data exposure. Diff-scoped only.
3. **Blast radius / design fit** — does the change belong here? Does it cross boundaries it shouldn't?
4. **Tests** — present where risk warrants, exercising behaviour not implementation.
5. **Convention adherence** — what `AGENTS.md` and adjacent code say.
6. **API & contract** — backward-compat, error semantics, public types.
7. **Naming & readability** — only when genuinely confusing.

## What not to flag

These destroy signal-to-noise:

- Pre-existing issues in unchanged code (diff-scoped only).
- Style and formatting a linter catches.
- "Could be more idiomatic" without a concrete reason.
- Theoretical performance concerns without measurement.
- Missing tests for trivial or mechanical changes.
- Documentation for self-evident code.

## Output

Markdown. Lead with one line summarising the change (the same summary from the skim pass) — always, even when there are no findings. Then up to three sections, all optional — omit any that's empty:

```
<one-line summary of the change>

## Must fix
- <statement>. `path/to/file.ts:42` — <suggested replacement *or* a question>

## Should consider
- ...

## Nits
- ...
```

End with one line — a verdict. One of: `Approve`, `Approve with must-fixes`, `Request changes`.

No praise section. No confidence scores. Include a committable suggestion only when it fully fixes the issue with no follow-up.

## Posting (remote PRs only)

If the user asks to post findings: use `gh pr review --comment`/`--request-changes` for the verdict, and `gh api` for inline comments anchored to `path` + `line`. Never auto-post.
