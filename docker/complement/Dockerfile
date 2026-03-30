# Stage 1: build — compile TypeScript bundle (rebuilds only when src/migrations change)
FROM node:20-bookworm-slim AS builder

WORKDIR /app

COPY package.json tsconfig.json ./
RUN npm install --no-fund --no-audit --no-package-lock

COPY src ./src
COPY migrations ./migrations
COPY wrangler.complement.jsonc ./wrangler.complement.jsonc

# Pre-compile TypeScript bundle so wrangler dev can skip compilation at container start
RUN node_modules/.bin/wrangler deploy \
      --dry-run \
      --outdir /app/dist \
      --config wrangler.complement.jsonc \
  && sed -i 's|"main": "src/index.ts"|"main": "dist/index.js"|' wrangler.complement.jsonc

# Stage 2: runtime — nginx/cert setup; only rebuilds when docker/complement changes
FROM node:20-bookworm-slim AS runtime

RUN apt-get update \
  && apt-get install -y --no-install-recommends bash ca-certificates curl nginx openssl \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/wrangler.complement.jsonc ./wrangler.complement.jsonc
COPY package.json ./
COPY migrations ./migrations

COPY docker/complement/entrypoint.sh /usr/local/bin/complement-entrypoint
COPY docker/complement/nginx.conf.template /etc/faas-matrix/complement-nginx.conf.template

RUN chmod +x /usr/local/bin/complement-entrypoint

ARG DIRTY_RUNS=0
ENV COMPLEMENT_ENABLE_DIRTY_RUNS=$DIRTY_RUNS

EXPOSE 8008 8448

HEALTHCHECK --interval=10s --timeout=5s --retries=12 CMD curl -fsS http://127.0.0.1:8008/_matrix/client/versions >/dev/null || exit 1

ENTRYPOINT ["/usr/local/bin/complement-entrypoint"]
