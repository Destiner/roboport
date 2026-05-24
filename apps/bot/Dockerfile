# Build context expected to be the monorepo root.
FROM oven/bun:1-alpine

RUN apk add --no-cache git github-cli ripgrep

WORKDIR /app

COPY package.json bun.lock bunfig.toml tsconfig.json ./
COPY apps/bot/package.json ./apps/bot/
COPY packages/drone/package.json ./packages/drone/

RUN bun install --frozen-lockfile

COPY packages/drone ./packages/drone
COPY apps/bot ./apps/bot

ENV NODE_ENV=production
EXPOSE 3000

CMD ["bun", "run", "/app/apps/bot/src/index.ts"]
