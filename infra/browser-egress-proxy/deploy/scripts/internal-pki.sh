#!/usr/bin/env bash
set -euo pipefail
umask 077

usage() {
  cat >&2 <<'EOF'
Usage:
  internal-pki.sh generate OUTPUT_DIR DIALER_INTERNAL_DNS CLIENT_SPIFFE_ID [LEAF_DAYS]
  internal-pki.sh verify OUTPUT_DIR DIALER_INTERNAL_DNS CLIENT_SPIFFE_ID
  internal-pki.sh bundle OLD_CA_PEM NEW_CA_PEM OUTPUT_CA_BUNDLE

This tool writes private keys. Use an ignored, access-controlled operator
directory and never commit or paste its output into a task, log, or ticket.
EOF
  exit 2
}

fail() {
  echo "internal PKI operation failed" >&2
  exit 1
}

require_tools() {
  command -v openssl >/dev/null 2>&1 || fail
}

validate_dns_name() {
  local value="$1"
  [[ "${value}" =~ ^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*\.internal$ ]] || fail
  [[ "${value}" != *replace-with-reviewed* ]] || fail
}

validate_spiffe() {
  [[ "$1" == "spiffe://maintainflow/interceptor" ]] || fail
}

certificate_fingerprint() {
  openssl x509 -in "$1" -noout -fingerprint -sha256 | sed 's/^.*=//'
}

verify_material() {
  local directory="$1"
  local dialer_dns="$2"
  local client_spiffe="$3"
  local client_identity="${directory}/${dialer_dns}.pem"

  validate_dns_name "${dialer_dns}"
  validate_spiffe "${client_spiffe}"
  for file in \
    "${directory}/dialer-server-ca.pem" \
    "${directory}/interceptor-client-ca.pem" \
    "${directory}/dialer.pem" \
    "${directory}/dialer.key" \
    "${directory}/interceptor.pem" \
    "${directory}/interceptor.key" \
    "${client_identity}"; do
    [[ -f "${file}" && -s "${file}" ]] || fail
  done

  openssl verify -CAfile "${directory}/dialer-server-ca.pem" -purpose sslserver "${directory}/dialer.pem" >/dev/null || fail
  openssl verify -CAfile "${directory}/interceptor-client-ca.pem" -purpose sslclient "${directory}/interceptor.pem" >/dev/null || fail
  openssl x509 -in "${directory}/dialer.pem" -checkend 0 -noout >/dev/null || fail
  openssl x509 -in "${directory}/interceptor.pem" -checkend 0 -noout >/dev/null || fail

  openssl x509 -in "${directory}/dialer.pem" -noout -text \
    | grep -F "DNS:${dialer_dns}" >/dev/null || fail
  openssl x509 -in "${directory}/interceptor.pem" -noout -text \
    | grep -F "URI:${client_spiffe}" >/dev/null || fail

  local cert_public key_public
  cert_public="$(openssl x509 -in "${directory}/dialer.pem" -pubkey -noout | openssl pkey -pubin -outform DER | openssl dgst -sha256)"
  key_public="$(openssl pkey -in "${directory}/dialer.key" -pubout -outform DER | openssl dgst -sha256)"
  [[ "${cert_public}" == "${key_public}" ]] || fail
  cert_public="$(openssl x509 -in "${directory}/interceptor.pem" -pubkey -noout | openssl pkey -pubin -outform DER | openssl dgst -sha256)"
  key_public="$(openssl pkey -in "${directory}/interceptor.key" -pubout -outform DER | openssl dgst -sha256)"
  [[ "${cert_public}" == "${key_public}" ]] || fail

  cmp -s \
    <(cat "${directory}/interceptor.pem" "${directory}/interceptor.key") \
    "${client_identity}" || fail
}

generate_material() {
  local output_directory="$1"
  local dialer_dns="$2"
  local client_spiffe="$3"
  local leaf_days="${4:-90}"

  validate_dns_name "${dialer_dns}"
  validate_spiffe "${client_spiffe}"
  [[ "${leaf_days}" =~ ^[0-9]+$ ]] || fail
  (( leaf_days >= 1 && leaf_days <= 397 )) || fail
  [[ ! -e "${output_directory}" ]] || fail
  mkdir -m 0700 "${output_directory}" || fail

  local temporary_directory
  temporary_directory="$(mktemp -d "${output_directory}/.work.XXXXXX")"
  trap 'rm -rf -- "${temporary_directory}"' EXIT

  # Separate roots prevent either trust bundle from authorizing the opposite
  # role. Keep both CA private keys offline after leaf issuance.
  openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 \
    -out "${output_directory}/dialer-server-ca.key" >/dev/null 2>&1
  openssl req -x509 -new -sha256 \
    -key "${output_directory}/dialer-server-ca.key" \
    -days 825 \
    -subj "/CN=Maintain Flow dialer server CA" \
    -addext "basicConstraints=critical,CA:TRUE,pathlen:0" \
    -addext "keyUsage=critical,keyCertSign,cRLSign" \
    -addext "subjectKeyIdentifier=hash" \
    -out "${output_directory}/dialer-server-ca.pem" >/dev/null 2>&1

  openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 \
    -out "${output_directory}/interceptor-client-ca.key" >/dev/null 2>&1
  openssl req -x509 -new -sha256 \
    -key "${output_directory}/interceptor-client-ca.key" \
    -days 825 \
    -subj "/CN=Maintain Flow interceptor client CA" \
    -addext "basicConstraints=critical,CA:TRUE,pathlen:0" \
    -addext "keyUsage=critical,keyCertSign,cRLSign" \
    -addext "subjectKeyIdentifier=hash" \
    -out "${output_directory}/interceptor-client-ca.pem" >/dev/null 2>&1

  openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 \
    -out "${output_directory}/dialer.key" >/dev/null 2>&1
  openssl req -new -sha256 \
    -key "${output_directory}/dialer.key" \
    -subj "/CN=${dialer_dns}" \
    -out "${temporary_directory}/dialer.csr" >/dev/null 2>&1
  cat > "${temporary_directory}/dialer.ext" <<EOF
basicConstraints=critical,CA:FALSE
keyUsage=critical,digitalSignature
extendedKeyUsage=serverAuth
subjectAltName=DNS:${dialer_dns}
subjectKeyIdentifier=hash
authorityKeyIdentifier=keyid,issuer
EOF
  openssl x509 -req -sha256 \
    -in "${temporary_directory}/dialer.csr" \
    -CA "${output_directory}/dialer-server-ca.pem" \
    -CAkey "${output_directory}/dialer-server-ca.key" \
    -set_serial "0x$(openssl rand -hex 16)" \
    -days "${leaf_days}" \
    -extfile "${temporary_directory}/dialer.ext" \
    -out "${output_directory}/dialer.pem" >/dev/null 2>&1

  openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 \
    -out "${output_directory}/interceptor.key" >/dev/null 2>&1
  openssl req -new -sha256 \
    -key "${output_directory}/interceptor.key" \
    -subj "/CN=Maintain Flow browser egress interceptor" \
    -out "${temporary_directory}/interceptor.csr" >/dev/null 2>&1
  cat > "${temporary_directory}/interceptor.ext" <<EOF
basicConstraints=critical,CA:FALSE
keyUsage=critical,digitalSignature
extendedKeyUsage=clientAuth
subjectAltName=URI:${client_spiffe}
subjectKeyIdentifier=hash
authorityKeyIdentifier=keyid,issuer
EOF
  openssl x509 -req -sha256 \
    -in "${temporary_directory}/interceptor.csr" \
    -CA "${output_directory}/interceptor-client-ca.pem" \
    -CAkey "${output_directory}/interceptor-client-ca.key" \
    -set_serial "0x$(openssl rand -hex 16)" \
    -days "${leaf_days}" \
    -extfile "${temporary_directory}/interceptor.ext" \
    -out "${output_directory}/interceptor.pem" >/dev/null 2>&1

  cat "${output_directory}/interceptor.pem" "${output_directory}/interceptor.key" \
    > "${output_directory}/${dialer_dns}.pem"
  chmod 0600 "${output_directory}"/*
  verify_material "${output_directory}" "${dialer_dns}" "${client_spiffe}"

  {
    printf 'dialer_server_ca_sha256=%s\n' "$(certificate_fingerprint "${output_directory}/dialer-server-ca.pem")"
    printf 'interceptor_client_ca_sha256=%s\n' "$(certificate_fingerprint "${output_directory}/interceptor-client-ca.pem")"
    printf 'dialer_certificate_sha256=%s\n' "$(certificate_fingerprint "${output_directory}/dialer.pem")"
    printf 'interceptor_certificate_sha256=%s\n' "$(certificate_fingerprint "${output_directory}/interceptor.pem")"
    printf 'dialer_not_after=%s\n' "$(openssl x509 -in "${output_directory}/dialer.pem" -noout -enddate | cut -d= -f2-)"
    printf 'interceptor_not_after=%s\n' "$(openssl x509 -in "${output_directory}/interceptor.pem" -noout -enddate | cut -d= -f2-)"
  } > "${output_directory}/public-manifest.txt"
  chmod 0600 "${output_directory}/public-manifest.txt"

  rm -rf -- "${temporary_directory}"
  trap - EXIT
  echo "Internal mTLS material generated and verified in the requested private directory." >&2
}

bundle_ca_certificates() {
  local old_ca="$1"
  local new_ca="$2"
  local output="$3"
  [[ -f "${old_ca}" && -f "${new_ca}" && ! -e "${output}" ]] || fail
  openssl x509 -in "${old_ca}" -noout -checkend 0 >/dev/null || fail
  openssl x509 -in "${new_ca}" -noout -checkend 0 >/dev/null || fail
  {
    openssl x509 -in "${old_ca}" -outform PEM
    openssl x509 -in "${new_ca}" -outform PEM
  } > "${output}"
  chmod 0600 "${output}"
}

require_tools
case "${1:-}" in
  generate)
    [[ $# -ge 4 && $# -le 5 ]] || usage
    generate_material "$2" "$3" "$4" "${5:-90}"
    ;;
  verify)
    [[ $# -eq 4 ]] || usage
    verify_material "$2" "$3" "$4"
    ;;
  bundle)
    [[ $# -eq 4 ]] || usage
    bundle_ca_certificates "$2" "$3" "$4"
    ;;
  *)
    usage
    ;;
esac
