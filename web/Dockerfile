# Static dashboard served by nginx, which also proxies /api to the API container.
# Build from the repository root:  docker build -f web/Dockerfile .

FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci --workspace=web --include-workspace-root=false
COPY web/ web/
RUN npm run build --workspace=web

FROM nginx:1.27-alpine
COPY web/nginx.conf /etc/nginx/templates/default.conf.template
COPY --from=build /app/web/dist /usr/share/nginx/html
ENV API_UPSTREAM=api:4000
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=3s CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1
