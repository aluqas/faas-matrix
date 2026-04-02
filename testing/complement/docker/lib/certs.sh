#!/usr/bin/env bash

install_complement_ca() {
  log_json info startup.ca_install "Installing Complement CA bundle when present"
  if [ -f /complement/ca/ca.crt ]; then
    cp /complement/ca/ca.crt /usr/local/share/ca-certificates/complement.crt
    update-ca-certificates >/dev/null 2>&1 || true
  fi
}

generate_server_certificate() {
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
}
