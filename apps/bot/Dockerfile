# Build context expected to be the monorepo root.
FROM oven/bun:1-alpine

RUN apk add --no-cache bash git github-cli ripgrep

WORKDIR /app

COPY package.json bun.lock bunfig.toml tsconfig.json ./
COPY apps/bot/package.json ./apps/bot/
COPY apps/docs/package.json ./apps/docs/
COPY packages/roboport/package.json ./packages/roboport/

RUN bun install --frozen-lockfile --filter '@roboport/bot'

COPY packages/roboport ./packages/roboport
COPY apps/bot ./apps/bot

ENV NODE_ENV=production
EXPOSE 3000

CMD ["bun", "run", "/app/apps/bot/src/index.ts"]
