FROM node:22-alpine AS build

WORKDIR /app
RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/package.json
COPY packages/server/package.json packages/server/package.json
COPY packages/web/package.json packages/web/package.json
RUN pnpm install --frozen-lockfile

COPY packages packages
COPY infra/header-source.mjs infra/headers.json ./infra/
RUN pnpm --filter web build
RUN pnpm --filter server... build
# pnpm 10+ deploy requires injected workspace packages; prefer deprecated --legacy because injectWorkspacePackages: true changes local installs and the lockfile pinned by --frozen-lockfile.
# Replace --legacy with the injected-workspace approach when it is removed.
RUN pnpm deploy --legacy --filter server --prod /app/runtime

FROM node:22-alpine AS runtime

WORKDIR /app
RUN addgroup -S mayo && adduser -S mayo -G mayo

COPY --from=build /app/runtime/ ./
COPY --from=build /app/packages/server/dist ./dist
COPY --from=build /app/packages/web/dist ./web-dist

ENV NODE_ENV=production
ENV PORT=3000
ENV WEB_ROOT=/app/web-dist

RUN mkdir -p /app/state && chown -R mayo:mayo /app
USER mayo

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/healthz || exit 1

CMD ["node", "dist/index.js"]
