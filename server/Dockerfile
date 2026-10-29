# One image runs the API, the worker and migrations (different commands).
# Build from the repository root:  docker build -f server/Dockerfile .

FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci --workspace=server --include-workspace-root=false
COPY server/ server/
RUN npm run build --workspace=server

FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci --workspace=server --include-workspace-root=false --omit=dev && npm cache clean --force

FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
RUN apk add --no-cache tini
COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/server/dist ./server/dist
COPY --chown=node:node server/migrations ./server/migrations
COPY --chown=node:node server/package.json ./server/package.json
USER node
EXPOSE 4000 9465
# tini forwards SIGTERM so in-flight checks and requests drain on shutdown.
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "server/dist/api/main.js"]
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s CMD wget -qO- http://127.0.0.1:${PORT:-4000}/health || exit 1
