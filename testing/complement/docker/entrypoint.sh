#!/usr/bin/env bash
set -euo pipefail

LIB_DIR="${COMPLEMENT_LIB_DIR:-/usr/local/lib/faas-matrix-complement}"
source "${LIB_DIR}/log.sh"
source "${LIB_DIR}/state.sh"
source "${LIB_DIR}/certs.sh"
source "${LIB_DIR}/wrangler.sh"
source "${LIB_DIR}/nginx.sh"

APP_DIR="/app"
WRANGLER_CONFIG="${WRANGLER_CONFIG:-wrangler.complement.jsonc}"
WRANGLER_PORT="${WRANGLER_PORT:-8008}"
WRANGLER_IP="${WRANGLER_IP:-0.0.0.0}"
CLIENT_PORT="${CLIENT_PORT:-8008}"
FEDERATION_PORT="${FEDERATION_PORT:-8448}"
PERSIST_DIR="${PERSIST_DIR:-/data/wrangler}"
PERSIST_SENTINEL="${PERSIST_DIR}/.container-hostname"
TEMPLATE_DIR="${TEMPLATE_DIR:-/data/wrangler-template}"
TEMPLATE_VERSION_FILE="${TEMPLATE_DIR}/.schema-hash"
IMAGE_TEMPLATE_DIR="${IMAGE_TEMPLATE_DIR:-/opt/faas-matrix-d1-template}"
IMAGE_TEMPLATE_VERSION_FILE="${IMAGE_TEMPLATE_DIR}/.schema-hash"
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
CURRENT_CONTAINER_HOSTNAME=""
NEEDS_INIT=0
WRANGLER_PID=""
NGINX_PID=""

cleanup() {
  if [ -n "${NGINX_PID:-}" ]; then
    kill "${NGINX_PID}" >/dev/null 2>&1 || true
  fi
  if [ -n "${WRANGLER_PID:-}" ]; then
    kill "${WRANGLER_PID}" >/dev/null 2>&1 || true
  fi
}

wait_for_foreground_processes() {
  set +e
  wait -n "${WRANGLER_PID}" "${NGINX_PID}"
  local status=$?
  set -e

  local exited_process="unknown"
  if ! kill -0 "${WRANGLER_PID}" >/dev/null 2>&1 && ! kill -0 "${NGINX_PID}" >/dev/null 2>&1; then
    exited_process="wrangler+nginx"
  elif ! kill -0 "${WRANGLER_PID}" >/dev/null 2>&1; then
    exited_process="wrangler"
  elif ! kill -0 "${NGINX_PID}" >/dev/null 2>&1; then
    exited_process="nginx"
  fi

  log_json info startup.wait.exit "A foreground startup process exited" \
    process "${exited_process}" \
    exit_code "${status}"

  cleanup
  exit "${status}"
}

trap cleanup INT TERM EXIT

log_json info startup.begin "Starting complement wrapper" \
  server_name "${SERVER_NAME}" \
  wrangler_config "${WRANGLER_CONFIG}" \
  feature_profile "${MATRIX_FEATURE_PROFILE}" \
  debug_startup "${COMPLEMENT_DEBUG_STARTUP}"

prepare_persisted_state
install_complement_ca
generate_server_certificate
write_dev_vars
write_nginx_config

cd "${APP_DIR}"

prepare_local_schema
start_wrangler
wait_for_wrangler_ready
run_recover_hook
start_nginx
wait_for_foreground_processes
