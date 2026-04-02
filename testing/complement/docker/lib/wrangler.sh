#!/usr/bin/env bash

write_dev_vars() {
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
}

start_wrangler() {
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
}

wait_for_wrangler_ready() {
  log_json info startup.wrangler.ready_wait.begin "Waiting for wrangler /versions healthcheck"
  local attempts=0
  local max_attempts=80
  until curl -fsS "http://127.0.0.1:${WRANGLER_PORT}/_internal/ready" >/dev/null 2>&1; do
    attempts=$((attempts + 1))
    if [ "${attempts}" -ge "${max_attempts}" ]; then
      log_json error startup.wrangler.ready_wait.end "Wrangler dev did not become healthy in time" \
        attempts "${attempts}"
      exit 1
    fi
    sleep 0.25
  done
  log_json info startup.wrangler.ready_wait.end "Wrangler dev became healthy" attempts "${attempts}"
}

run_recover_hook() {
  log_json info startup.recover.begin "Calling federation recovery hook"
  curl -fsS -X POST "http://127.0.0.1:${WRANGLER_PORT}/_internal/federation/recover" >/dev/null 2>&1 || true
  log_json info startup.recover.end "Federation recovery hook completed"
}
