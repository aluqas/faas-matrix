#!/usr/bin/env bash

write_nginx_config() {
  sed \
    -e "s#__CLIENT_PORT__#${CLIENT_PORT}#g" \
    -e "s#__FEDERATION_PORT__#${FEDERATION_PORT}#g" \
    -e "s#__WRANGLER_PORT__#${WRANGLER_PORT}#g" \
    -e "s#__SERVER_NAME__#${SERVER_NAME}#g" \
    -e "s#__TLS_CERT__#${TLS_DIR}/${SERVER_NAME}.crt#g" \
    -e "s#__TLS_KEY__#${TLS_DIR}/${SERVER_NAME}.key#g" \
    "${NGINX_TEMPLATE}" > "${NGINX_CONFIG}"
}

start_nginx() {
  log_json info startup.nginx.begin "Starting nginx federation TLS proxy" federation_port "${FEDERATION_PORT}"
  nginx -g 'daemon off;' &
  NGINX_PID=$!
}
