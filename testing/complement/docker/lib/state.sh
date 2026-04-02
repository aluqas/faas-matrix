#!/usr/bin/env bash

has_populated_directory() {
  local dir="$1"
  [ -d "${dir}" ] && [ -n "$(find "${dir}" -mindepth 1 -maxdepth 1 2>/dev/null)" ]
}

restore_image_template() {
  local schema_hash="$1"
  if [ ! -f "${IMAGE_TEMPLATE_VERSION_FILE}" ]; then
    return 1
  fi

  local image_hash
  image_hash="$(cat "${IMAGE_TEMPLATE_VERSION_FILE}" 2>/dev/null || true)"
  if [ "${image_hash}" != "${schema_hash}" ]; then
    return 1
  fi

  if ! has_populated_directory "${IMAGE_TEMPLATE_DIR}"; then
    return 1
  fi

  rm -rf "${TEMPLATE_DIR}"
  mkdir -p "${TEMPLATE_DIR}"
  cp -a "${IMAGE_TEMPLATE_DIR}/." "${TEMPLATE_DIR}/"
  printf '%s' "${schema_hash}" > "${TEMPLATE_VERSION_FILE}"
  log_json info startup.template.image_reuse "Restored cached local D1 template from image" \
    schema_hash "${schema_hash}"
  return 0
}

compute_schema_hash() {
  (
    for file in ./migrations/schema.sql ./migrations/[0-9]*.sql "./${WRANGLER_CONFIG}"; do
      printf '%s\n' "${file}"
      cat "${file}"
    done
  ) | openssl dgst -sha256 -r | awk '{print $1}'
}

ensure_d1_template() {
  local schema_hash="$1"

  if [ -f "${TEMPLATE_VERSION_FILE}" ]; then
    local existing_hash
    existing_hash="$(cat "${TEMPLATE_VERSION_FILE}" 2>/dev/null || true)"
    if [ "${existing_hash}" = "${schema_hash}" ] && [ -n "$(find "${TEMPLATE_DIR}" -mindepth 1 -maxdepth 1 2>/dev/null)" ]; then
      log_json info startup.template.reuse "Reusing cached local D1 template" \
        schema_hash "${schema_hash}"
      return
    fi
  fi

  if restore_image_template "${schema_hash}"; then
    return
  fi

  local build_dir
  build_dir="$(mktemp -d /tmp/wrangler-template-XXXXXX)"
  rm -rf "${TEMPLATE_DIR}"
  mkdir -p "${TEMPLATE_DIR}"

  log_json info startup.template.build.begin "Building cached local D1 template" \
    schema_hash "${schema_hash}"
  local combined_sql
  combined_sql="$(mktemp /tmp/migrations-XXXXXX.sql)"
  cat ./migrations/schema.sql ./migrations/[0-9]*.sql > "${combined_sql}"
  "${WRANGLER_BIN}" d1 execute tuwunel-db \
    --config "${WRANGLER_CONFIG}" \
    --local \
    --persist-to "${build_dir}" \
    --file "${combined_sql}" >/dev/null
  rm -f "${combined_sql}"
  cp -a "${build_dir}/." "${TEMPLATE_DIR}/"
  printf '%s' "${schema_hash}" > "${TEMPLATE_VERSION_FILE}"
  rm -rf "${build_dir}"
  log_json info startup.template.build.end "Built cached local D1 template" \
    schema_hash "${schema_hash}"
}

prepare_persisted_state() {
  local previous_container_hostname=""
  if [ -f "${PERSIST_SENTINEL}" ]; then
    previous_container_hostname="$(cat "${PERSIST_SENTINEL}" 2>/dev/null || true)"
  fi

  CURRENT_CONTAINER_HOSTNAME="$(hostname)"
  NEEDS_INIT=0
  if [ -z "${previous_container_hostname}" ] || [ "${previous_container_hostname}" != "${CURRENT_CONTAINER_HOSTNAME}" ]; then
    log_json info startup.state_reset "Resetting persisted wrangler state for a new container" \
      previous_hostname "${previous_container_hostname}" \
      current_hostname "${CURRENT_CONTAINER_HOSTNAME}"
    rm -rf "${PERSIST_DIR}"
    NEEDS_INIT=1
  else
    log_json info startup.state_reset "Reusing persisted wrangler state for the same container" \
      current_hostname "${CURRENT_CONTAINER_HOSTNAME}"
  fi

  mkdir -p "${PERSIST_DIR}" "${TLS_DIR}" "${TEMPLATE_DIR}"
  printf '%s' "${CURRENT_CONTAINER_HOSTNAME}" > "${PERSIST_SENTINEL}"
}

prepare_local_schema() {
  log_json info startup.migrate.begin "Preparing local D1 schema" needs_init "${NEEDS_INIT}"
  local schema_hash
  schema_hash="$(compute_schema_hash)"
  if [ "${NEEDS_INIT}" = "1" ]; then
    ensure_d1_template "${schema_hash}"
    log_json info startup.template.restore.begin "Restoring cached local D1 template" \
      schema_hash "${schema_hash}"
    cp -a "${TEMPLATE_DIR}/." "${PERSIST_DIR}/"
    printf '%s' "${CURRENT_CONTAINER_HOSTNAME}" > "${PERSIST_SENTINEL}"
    log_json info startup.template.restore.end "Restored cached local D1 template" \
      schema_hash "${schema_hash}"
    log_json info startup.migrate.end "Restored local D1 schema from template" \
      needs_init "${NEEDS_INIT}" \
      schema_hash "${schema_hash}"
  else
    log_json info startup.migrate.end "Skipped local D1 schema because persisted state was reused" \
      needs_init "${NEEDS_INIT}" \
      schema_hash "${schema_hash}"
  fi
}
