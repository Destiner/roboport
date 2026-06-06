# Build context expected to be the monorepo root.
FROM oven/bun:1-alpine

WORKDIR /app

COPY package.json bun.lock bunfig.toml tsconfig.json ./
COPY apps/bot/package.json ./apps/bot/
COPY apps/docs/package.json ./apps/docs/
COPY packages/roboport/package.json ./packages/roboport/

RUN bun install --frozen-lockfile --filter '@roboport/docs'

COPY packages/roboport ./packages/roboport
COPY apps/docs ./apps/docs

RUN cd apps/docs && bun run build

ENV NODE_ENV=production
EXPOSE 3000

CMD ["sh", "-c", "cd /app/apps/docs && bunx vocs preview --port ${PORT:-3000} --host 0.0.0.0"]
