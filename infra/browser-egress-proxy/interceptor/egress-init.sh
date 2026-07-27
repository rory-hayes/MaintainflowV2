#!/bin/sh
set -eu

python /opt/maintainflow/interceptor/post_image_verify.py \
  --manifest /opt/maintainflow/interceptor/pinned-source.json

case "${MF_AUDIT_FD:-}" in
  ''|*[!0-9]*)
    echo "MF_AUDIT_FD must name a pre-opened dedicated descriptor." >&2
    exit 1
    ;;
esac
if [ "${MF_AUDIT_FD}" -lt 3 ] || [ ! -e "/proc/self/fd/${MF_AUDIT_FD}" ]; then
  echo "MF_AUDIT_FD must name a pre-opened dedicated descriptor." >&2
  exit 1
fi

exec mitmdump \
  --mode "upstream:${MF_DIALER_PROXY_URL}" \
  --listen-host 0.0.0.0 \
  --listen-port 8080 \
  --set "client_certs=${MF_DIALER_CLIENT_CERT_DIR}" \
  --set "ssl_verify_upstream_trusted_ca=${MF_DIALER_SERVER_CA_FILE}" \
  --set ssl_insecure=false \
  --set http_connect_send_host_header=true \
  --set upstream_cert=true \
  --set tls_version_server_min=TLS1_2 \
  --set rawtcp=false \
  --set websocket=false \
  --set http2=true \
  --set http3=false \
  --set connection_strategy=lazy \
  --set body_size_limit=20m \
  --set stream_large_bodies=1 \
  --set store_streamed_bodies=false \
  --set validate_inbound_headers=true \
  --set tcp_timeout=30 \
  --set block_global=false \
  --set flow_detail=0 \
  --set termlog_verbosity=error \
  --set showhost=false \
  -s /opt/maintainflow/interceptor/load_policy.py
