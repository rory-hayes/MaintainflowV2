#!/bin/sh
set -eu
umask 077

fail() {
  echo "interceptor startup failed closed" >&2
  exit 1
}

[ "$(id -u)" -eq 0 ] || fail
for command in nft python3 setpriv mktemp install chown; do
  command -v "${command}" >/dev/null 2>&1 || fail
done

install -d -m 0711 -o root -g root /run/maintainflow
runtime_directory="$(mktemp -d /run/maintainflow/interceptor.XXXXXX)"

# Install the default-drop boundary before DNS resolution, secret handling, or
# starting the proxy. The only new outbound flows are Fly DNS and members of an
# initially empty approved-dialer set.
if nft list table inet mf_interceptor_boundary >/dev/null 2>&1; then
  nft delete table inet mf_interceptor_boundary || fail
fi
nft -f /opt/maintainflow/deploy/interceptor-bootstrap.nft || fail

python3 /opt/maintainflow/deploy/runtime_guard.py prepare-interceptor \
  --runtime-dir "${runtime_directory}" \
  --nft-output "${runtime_directory}/dialer-set.nft" \
  --hosts-output "${runtime_directory}/dialer.hosts" || fail

nft -f "${runtime_directory}/dialer-set.nft" || fail
while read -r private_address private_name; do
  [ -n "${private_address}" ] && [ -n "${private_name}" ] || fail
  printf '%s\t%s\n' "${private_address}" "${private_name}" >> /etc/hosts || fail
done < "${runtime_directory}/dialer.hosts"

export HOME="${runtime_directory}/home"
export MF_DIALER_CLIENT_CERT_DIR="${runtime_directory}/dialer-client"
export MF_DIALER_SERVER_CA_FILE="${runtime_directory}/dialer-server-ca.pem"
export MF_AUDIT_FD=3
unset MF_DIALER_CLIENT_IDENTITY_B64 MF_DIALER_SERVER_CA_B64 MF_INTERCEPTION_CA_PEM_B64

chown -R 10001:10001 \
  "${runtime_directory}" \
  "${runtime_directory}/home" \
  "${runtime_directory}/dialer-client" \
  "${runtime_directory}/dialer-server-ca.pem" || fail

# Audit JSON receives a dedicated inherited descriptor. Production retention
# and delivery for the Fly log stream remain an explicit release gate.
exec 3>&1
exec setpriv \
  --reuid=10001 \
  --regid=10001 \
  --clear-groups \
  --no-new-privs \
  --inh-caps=-all \
  --ambient-caps=-all \
  --bounding-set=-all \
  -- /opt/maintainflow/interceptor/egress-init.sh
