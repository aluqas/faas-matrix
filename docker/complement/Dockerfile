FROM node:20-bookworm-slim AS base

RUN apt-get update \
  && apt-get install -y --no-install-recommends bash ca-certificates curl nginx openssl \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json tsconfig.json ./
RUN npm install --no-fund --no-audit

COPY src ./src
COPY migrations ./migrations
COPY wrangler.complement.jsonc ./wrangler.complement.jsonc
COPY docker/complement/entrypoint.sh /usr/local/bin/complement-entrypoint
COPY docker/complement/nginx.conf.template /etc/faas-matrix/complement-nginx.conf.template

RUN chmod +x /usr/local/bin/complement-entrypoint

EXPOSE 8008 8448

HEALTHCHECK --interval=10s --timeout=5s --retries=12 CMD curl -fsS http://127.0.0.1:8008/_matrix/client/versions >/dev/null || exit 1

ENTRYPOINT ["/usr/local/bin/complement-entrypoint"]
