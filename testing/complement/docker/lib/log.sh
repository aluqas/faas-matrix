#!/usr/bin/env bash

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
