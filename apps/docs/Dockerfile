# Build context expected to be the monorepo root.
FROM oven/bun:1-alpine

WORKDIR /app

COPY package.json bun.lock bunfig.toml tsconfig.json ./
COPY apps/bot/package.json ./apps/bot/
COPY apps/docs/package.json ./apps/docs/
COPY packages/drone/package.json ./packages/drone/

RUN bun install --frozen-lockfile --filter '@drone/docs'

COPY packages/drone ./packages/drone
COPY apps/docs ./apps/docs

RUN cd apps/docs && bun run build

ENV NODE_ENV=production
EXPOSE 3000

CMD ["sh", "-c", "cd /app/apps/docs && bunx vocs preview --port ${PORT:-3000} --host 0.0.0.0"]
