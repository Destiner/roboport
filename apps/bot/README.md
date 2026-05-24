# bot

Webhook-driven runner for drone agents. Receives GitHub webhooks and dispatches the `pr-review` and `docs-update` workflows in parallel per actionable PR event.

## Endpoints

- `GET /` — health check
- `POST /webhooks/github` — GitHub webhook receiver (HMAC-verified)

## Environment

Required:

- `GH_TOKEN` — fine-grained PAT with `contents: write` and `pull-requests: write` on the target repo
- `GITHUB_WEBHOOK_SECRET` — same secret configured on the repo webhook
- `DRONE_ALLOWED_ACTORS` — comma-separated GitHub logins permitted to trigger workflows
- `DRONE_GIT_USER_NAME`, `DRONE_GIT_USER_EMAIL` — git identity used by docs-update commits

Optional:

- `PORT` (default `3000`)
- `DRONE_OPENAI_CODEX_AUTH_FILE` (default `/data/openai-codex-auth.json`) — codex auth/refresh-token store

## Deployment (Railway)

- Build context: monorepo root
- Dockerfile: `apps/bot/Dockerfile`
- Volume: mount at `/data`; seed `openai-codex-auth.json` once from your local `~/.codex/auth.json`. The codex model refreshes the file in place when tokens rotate.
- Webhook: point your GitHub repo webhook at `https://<service>/webhooks/github`, content type `application/json`, with the same secret as `GITHUB_WEBHOOK_SECRET`. Subscribe to **Pull requests** only.

## Local dev

```sh
bun --watch apps/bot/src/index.ts
```

Use `smee.io` or `gh webhook forward` to relay GitHub events to your local port.
