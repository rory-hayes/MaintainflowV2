#!/bin/sh
set -eu
umask 077

fail() {
  echo "policy dialer startup failed closed" >&2
  exit 1
}

[ "$(id -u)" -eq 0 ] || fail
for command in nft python3 setpriv mktemp install chown; do
  command -v "${command}" >/dev/null 2>&1 || fail
done

install -d -m 0711 -o root -g root /run/maintainflow
runtime_directory="$(mktemp -d /run/maintainflow/dialer.XXXXXX)"

# Nothing except loopback is allowed while endpoints, policy snapshots, and
# secret material are being validated.
if nft list table inet mf_dialer_boundary >/dev/null 2>&1; then
  nft delete table inet mf_dialer_boundary || fail
fi
nft -f /opt/maintainflow/deploy/dialer-bootstrap.nft || fail

python3 /opt/maintainflow/deploy/runtime_guard.py prepare-dialer \
  --runtime-dir "${runtime_directory}" \
  --nft-output "${runtime_directory}/dialer-final.nft" \
  --ipv4-registry /opt/maintainflow/policy/iana-ipv4-special-registry.xml \
  --ipv6-registry /opt/maintainflow/policy/iana-ipv6-special-registry.xml \
  --policy-manifest /opt/maintainflow/policy/policy-manifest.json || fail

# No workload has been started, so a final-table install failure leaves no
# reachable service. The entrypoint exits non-zero and Fly's on-failure policy
# handles the bounded restart attempts.
nft delete table inet mf_dialer_boundary || fail
nft -f "${runtime_directory}/dialer-final.nft" || fail

export MF_DIALER_LISTEN_ADDR="[${FLY_PRIVATE_IP}]:9443"
export MF_DIALER_HEALTH_ADDR="127.0.0.1:8081"
export MF_DIALER_TLS_CERT_FILE="${runtime_directory}/dialer-server.pem"
export MF_DIALER_TLS_KEY_FILE="${runtime_directory}/dialer-server.key"
export MF_DIALER_CLIENT_CA_FILE="${runtime_directory}/interceptor-client-ca.pem"
export MF_DIALER_DOMAIN_DENYLIST_FILE="/opt/maintainflow/policy/domain-denylist.yaml"
unset MF_DIALER_SERVER_CERT_B64 MF_DIALER_SERVER_KEY_B64 MF_DIALER_CLIENT_CA_B64

chown 10001:10001 \
  "${runtime_directory}" \
  "${runtime_directory}/dialer-server.pem" \
  "${runtime_directory}/dialer-server.key" \
  "${runtime_directory}/interceptor-client-ca.pem" || fail

exec setpriv \
  --reuid=10001 \
  --regid=10001 \
  --clear-groups \
  --no-new-privs \
  --inh-caps=-all \
  --ambient-caps=-all \
  --bounding-set=-all \
  -- /opt/maintainflow/bin/policy-dialer
