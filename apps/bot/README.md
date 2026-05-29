# bot

Webhook-driven runner for drone agents. Receives GitHub webhooks and dispatches the `pr-review`, `docs-update`, `simplify`, and `dx-audit` workflows per actionable PR event, plus a reply-to-apply path on inline review-comment replies.

## Endpoints

- `GET /` — health check
- `POST /webhooks/github` — GitHub webhook receiver (HMAC-verified)

## Environment

The bot authenticates as a GitHub App: it signs a JWT with the app private key,
exchanges it for a short-lived installation token, and keeps that token in
`GH_TOKEN` (rotated automatically) so `gh`/`git` post and push as the app's
`<app-slug>[bot]` identity.

Required:

- `GITHUB_APP_ID` — the app's numeric App ID
- `GITHUB_APP_PRIVATE_KEY` — the app private key PEM (raw, `\n`-escaped, or base64-encoded)
- `GITHUB_WEBHOOK_SECRET` — same secret configured on the app webhook
- `DRONE_ALLOWED_ACTORS` — comma-separated GitHub logins permitted to trigger workflows

App permissions: **Contents: Read & write**, **Pull requests: Read & write**,
and **Checks: Read & write** (plus the mandatory **Metadata: Read-only**).
Webhook events: **Pull request** and **Pull request review comment**.

The bot opens a check run per workflow (`drone / pr-review`, `drone / docs`,
`drone / simplify`, `drone / dx-audit`) on the PR head commit so its progress
shows in the PR UI. These are advisory — they conclude `neutral`, never gating
a merge; do not add them to branch protection's required checks.

Separately, `pr-review` submits a **review verdict**: `Approve` posts an
approval, while `Approve with must-fixes` and `Request changes` post
`--request-changes`, which blocks the merge until cleared. A later push re-runs
the workflow and the new verdict supersedes the old one, so a stale
request-changes self-clears. Unlike the check runs this is a *gating* surface —
factor it into branch-protection settings. (`dx-audit` stays advisory: it only
ever comments.)

Optional:

- `GITHUB_APP_INSTALLATION_ID` — required only if the app is installed in more than one place; otherwise auto-discovered
- `DRONE_GIT_USER_NAME`, `DRONE_GIT_USER_EMAIL` — override the commit author; default to the app's bot identity so commits link to the app
- `PORT` (default `3000`)
- `DRONE_OPENAI_CODEX_AUTH_FILE` (default `/data/openai-codex-auth.json`) — codex auth/refresh-token store

## Deployment (Railway)

- Build context: monorepo root
- Dockerfile: `apps/bot/Dockerfile`
- Volume: mount at `/data`. Seed `openai-codex-auth.json` once with a Codex grant **dedicated to the bot** — do not reuse your personal `~/.codex/auth.json`. Codex refresh tokens are single-use and rotate on every refresh, so two holders of the same `auth.json` invalidate each other (`refresh_token_reused`). Mint an isolated grant (e.g. via a separate `CODEX_HOME`) and copy it onto the volume; the bot refreshes it in place as tokens rotate.
- Webhook: configured once on the GitHub App (Settings → your app → Webhook). Point it at `https://<service>/webhooks/github`, content type `application/json`, with the same secret as `GITHUB_WEBHOOK_SECRET`. Subscribe to **Pull request** and **Pull request review comment** events (the latter drives the simplify reply-to-apply path).

## Local dev

```sh
bun --watch apps/bot/src/index.ts
```

Use `smee.io` or `gh webhook forward` to relay GitHub events to your local port.
