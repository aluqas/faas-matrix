#!/usr/bin/env bash
set -euo pipefail

json_escape() {
  local value="${1-}"
  value="${value//\\/\\\\}"
  value="${value//\"/\\\"}"
  value="${value//$'\n'/\\n}"
  value="${value//$'\r'/\\r}"
  value="${value//$'\t'/\\t}"
  printf '%s' "${value}"
}

log_json() {
  local level="$1"
  local event="$2"
  local message="$3"
  shift 3

  local line
  line="{\"ts\":\"$(date -u +"%Y-%m-%dT%H:%M:%SZ")\",\"level\":\"$(json_escape "${level}")\",\"event\":\"$(json_escape "${event}")\",\"message\":\"$(json_escape "${message}")\""
  while [ "$#" -gt 1 ]; do
    local key="$1"
    local value="$2"
    shift 2
    line="${line},\"$(json_escape "${key}")\":\"$(json_escape "${value}")\""
  done
  line="${line}}"
  printf '%s\n' "${line}" >&2
}

APP_DIR="/app"
WRANGLER_CONFIG="${WRANGLER_CONFIG:-wrangler.complement.jsonc}"
WRANGLER_PORT="${WRANGLER_PORT:-8008}"
WRANGLER_IP="${WRANGLER_IP:-0.0.0.0}"
CLIENT_PORT="${CLIENT_PORT:-8008}"
FEDERATION_PORT="${FEDERATION_PORT:-8448}"
PERSIST_DIR="${PERSIST_DIR:-/data/wrangler}"
PERSIST_SENTINEL="${PERSIST_DIR}/.container-hostname"
SERVER_NAME="${SERVER_NAME:-hs1}"
SERVER_VERSION="${SERVER_VERSION:-0.1.0-complement}"
MATRIX_FEATURE_PROFILE="${MATRIX_FEATURE_PROFILE:-complement}"
COMPLEMENT_DEBUG_STARTUP="${COMPLEMENT_DEBUG_STARTUP:-0}"
WRANGLER_LOG_LEVEL="${WRANGLER_LOG_LEVEL:-warn}"
TLS_DIR="/run/complement-tls"
DEV_VARS_FILE="${APP_DIR}/.dev.vars"
NGINX_TEMPLATE="/etc/faas-matrix/complement-nginx.conf.template"
NGINX_CONFIG="/etc/nginx/nginx.conf"
WRANGLER_BIN="${APP_DIR}/node_modules/.bin/wrangler"

log_json info startup.begin "Starting complement wrapper" \
  server_name "${SERVER_NAME}" \
  wrangler_config "${WRANGLER_CONFIG}" \
  feature_profile "${MATRIX_FEATURE_PROFILE}" \
  debug_startup "${COMPLEMENT_DEBUG_STARTUP}"

PREVIOUS_CONTAINER_HOSTNAME=""
if [ -f "${PERSIST_SENTINEL}" ]; then
  PREVIOUS_CONTAINER_HOSTNAME="$(cat "${PERSIST_SENTINEL}" 2>/dev/null || true)"
fi

CURRENT_CONTAINER_HOSTNAME="$(hostname)"
NEEDS_INIT=0
if [ -z "${PREVIOUS_CONTAINER_HOSTNAME}" ] || [ "${PREVIOUS_CONTAINER_HOSTNAME}" != "${CURRENT_CONTAINER_HOSTNAME}" ]; then
  log_json info startup.state_reset "Resetting persisted wrangler state for a new container" \
    previous_hostname "${PREVIOUS_CONTAINER_HOSTNAME}" \
    current_hostname "${CURRENT_CONTAINER_HOSTNAME}"
  rm -rf "${PERSIST_DIR}"
  NEEDS_INIT=1
else
  log_json info startup.state_reset "Reusing persisted wrangler state for the same container" \
    current_hostname "${CURRENT_CONTAINER_HOSTNAME}"
fi

mkdir -p "${PERSIST_DIR}" "${TLS_DIR}"
printf '%s' "${CURRENT_CONTAINER_HOSTNAME}" > "${PERSIST_SENTINEL}"

log_json info startup.ca_install "Installing Complement CA bundle when present"
if [ -f /complement/ca/ca.crt ]; then
  cp /complement/ca/ca.crt /usr/local/share/ca-certificates/complement.crt
  update-ca-certificates >/dev/null 2>&1 || true
fi

cat > "${TLS_DIR}/openssl.ext" <<EOF
subjectAltName=DNS:${SERVER_NAME}
extendedKeyUsage=serverAuth
EOF

log_json info startup.cert_generate "Generating server certificate" server_name "${SERVER_NAME}"
if [ -f /complement/ca/ca.key ] && [ -f /complement/ca/ca.crt ]; then
  openssl genrsa -out "${TLS_DIR}/${SERVER_NAME}.key" 2048 >/dev/null 2>&1
  openssl req -new -sha256 \
    -key "${TLS_DIR}/${SERVER_NAME}.key" \
    -subj "/C=US/ST=CA/O=Complement/CN=${SERVER_NAME}" \
    -out "${TLS_DIR}/${SERVER_NAME}.csr" >/dev/null 2>&1
  openssl x509 -req \
    -in "${TLS_DIR}/${SERVER_NAME}.csr" \
    -CA /complement/ca/ca.crt \
    -CAkey /complement/ca/ca.key \
    -CAcreateserial \
    -out "${TLS_DIR}/${SERVER_NAME}.crt" \
    -days 1 \
    -sha256 \
    -extfile "${TLS_DIR}/openssl.ext" >/dev/null 2>&1
else
  openssl req -x509 -nodes -newkey rsa:2048 \
    -keyout "${TLS_DIR}/${SERVER_NAME}.key" \
    -out "${TLS_DIR}/${SERVER_NAME}.crt" \
    -days 1 \
    -subj "/C=US/ST=CA/O=Complement/CN=${SERVER_NAME}" \
    -addext "subjectAltName=DNS:${SERVER_NAME}" >/dev/null 2>&1
fi

log_json info startup.dev_vars_write "Writing .dev.vars for wrangler dev" \
  feature_profile "${MATRIX_FEATURE_PROFILE}"
cat > "${DEV_VARS_FILE}" <<EOF
SERVER_NAME=${SERVER_NAME}
SERVER_VERSION=${SERVER_VERSION}
MATRIX_FEATURE_PROFILE=${MATRIX_FEATURE_PROFILE}
LIVEKIT_API_KEY=devkey
LIVEKIT_API_SECRET=devsecret
LIVEKIT_URL=wss://invalid.local
DISABLE_RATE_LIMIT=1
EOF

sed \
  -e "s#__CLIENT_PORT__#${CLIENT_PORT}#g" \
  -e "s#__FEDERATION_PORT__#${FEDERATION_PORT}#g" \
  -e "s#__WRANGLER_PORT__#${WRANGLER_PORT}#g" \
  -e "s#__SERVER_NAME__#${SERVER_NAME}#g" \
  -e "s#__TLS_CERT__#${TLS_DIR}/${SERVER_NAME}.crt#g" \
  -e "s#__TLS_KEY__#${TLS_DIR}/${SERVER_NAME}.key#g" \
  "${NGINX_TEMPLATE}" > "${NGINX_CONFIG}"

cd "${APP_DIR}"

log_json info startup.migrate.begin "Preparing local D1 schema" needs_init "${NEEDS_INIT}"
if [ "${NEEDS_INIT}" = "1" ]; then
  COMBINED_SQL="$(mktemp /tmp/migrations-XXXXXX.sql)"
  cat ./migrations/schema.sql ./migrations/[0-9]*.sql > "${COMBINED_SQL}"
  "${WRANGLER_BIN}" d1 execute tuwunel-db \
    --config "${WRANGLER_CONFIG}" \
    --local \
    --persist-to "${PERSIST_DIR}" \
    --file "${COMBINED_SQL}" >/dev/null
  rm -f "${COMBINED_SQL}"
  log_json info startup.migrate.end "Applied local D1 schema" needs_init "${NEEDS_INIT}"
else
  log_json info startup.migrate.end "Skipped local D1 schema because persisted state was reused" \
    needs_init "${NEEDS_INIT}"
fi

log_json info startup.wrangler.begin "Starting wrangler dev" \
  log_level "${WRANGLER_LOG_LEVEL}" \
  wrangler_port "${WRANGLER_PORT}"
"${WRANGLER_BIN}" dev \
  --config "${WRANGLER_CONFIG}" \
  --local \
  --ip "${WRANGLER_IP}" \
  --port "${WRANGLER_PORT}" \
  --persist-to "${PERSIST_DIR}" \
  --no-bundle \
  --log-level "${WRANGLER_LOG_LEVEL}" \
  --show-interactive-dev-session=false &
WRANGLER_PID=$!

cleanup() {
  if [ -n "${NGINX_PID:-}" ]; then
    kill "${NGINX_PID}" >/dev/null 2>&1 || true
  fi
  if [ -n "${WRANGLER_PID:-}" ]; then
    kill "${WRANGLER_PID}" >/dev/null 2>&1 || true
  fi
}

trap cleanup INT TERM EXIT

log_json info startup.wrangler.ready_wait.begin "Waiting for wrangler /versions healthcheck"
ATTEMPTS=0
until curl -fsS "http://127.0.0.1:${WRANGLER_PORT}/_matrix/client/versions" >/dev/null 2>&1; do
  ATTEMPTS=$((ATTEMPTS + 1))
  if [ "${ATTEMPTS}" -ge 20 ]; then
    log_json error startup.wrangler.ready_wait.end "Wrangler dev did not become healthy in time" \
      attempts "${ATTEMPTS}"
    exit 1
  fi
  sleep 1
done
log_json info startup.wrangler.ready_wait.end "Wrangler dev became healthy" attempts "${ATTEMPTS}"

log_json info startup.recover.begin "Calling federation recovery hook"
curl -fsS -X POST "http://127.0.0.1:${WRANGLER_PORT}/_internal/federation/recover" >/dev/null 2>&1 || true
log_json info startup.recover.end "Federation recovery hook completed"

log_json info startup.nginx.begin "Starting nginx federation TLS proxy" federation_port "${FEDERATION_PORT}"
nginx -g 'daemon off;' &
NGINX_PID=$!

set +e
wait -n "${WRANGLER_PID}" "${NGINX_PID}"
STATUS=$?
set -e

EXITED_PROCESS="unknown"
if ! kill -0 "${WRANGLER_PID}" >/dev/null 2>&1 && ! kill -0 "${NGINX_PID}" >/dev/null 2>&1; then
  EXITED_PROCESS="wrangler+nginx"
elif ! kill -0 "${WRANGLER_PID}" >/dev/null 2>&1; then
  EXITED_PROCESS="wrangler"
elif ! kill -0 "${NGINX_PID}" >/dev/null 2>&1; then
  EXITED_PROCESS="nginx"
fi

log_json info startup.wait.exit "A foreground startup process exited" \
  process "${EXITED_PROCESS}" \
  exit_code "${STATUS}"

cleanup
exit "${STATUS}"
