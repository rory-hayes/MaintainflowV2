# Patched interceptor runtime

The production interceptor does not install unmodified PyPI wheels. It builds
and verifies two reviewable, exact-source patches:

- mitmproxy `v12.2.3`, commit
  `6c09d56e4c29a92f5ad01b03199977584b8ea14f`;
- h11 `0.16.0`, from the pinned PyPI source archive whose SHA-256 is
  `4e35b956cf45792e4caa5885e69fba00bdbc6ffafbfa020300e549b208ee5ff1`.

`pinned-source.json` is the machine-readable contract. It records every patch
hash, exact touched-file list, and the before/after hash of each source file.
The verifiers refuse a different source, unexpected dirty file, patch drift, or
post-patch hash mismatch.

## Security controls supplied by the patches

- HTTP/1 request and response heads are capped at 65,536 raw bytes before
  semantic parsing. Bytes after the terminating blank line do not count.
- HTTP/2 request and response header lists are explicitly capped at 65,536
  decompressed HPACK bytes in both directions.
- Request bodies are capped at 2 MiB and response bodies at 20 MiB using
  cumulative bytes actually received. Forwarded bytes are counted separately,
  so a streaming addon cannot expand a body past the limit.
- h11 chunk-size lines plus extensions and trailer blocks are independently
  capped at 65,536 bytes. The exact boundary is accepted; the first excess byte
  fails before parser work, including when input arrives one fragment at a
  time.

The addon adds a second fail-closed layer: it accepts only unencoded responses
with no `Transfer-Encoding`, `identity`, or one plain `chunked` value; rejects
all raw non-ASCII host input; and refuses to start unless all patch sentinels
and reviewed runtime options are present.

## Source verification

On clean disposable sources, apply and test the mitmproxy patches with:

```sh
python3 verify_patch.py \
  --source /tmp/mitmproxy-12.2.3 \
  --apply \
  --test \
  --python /tmp/mitmproxy-12.2.3/.venv/bin/python
```

Apply and test the h11 patch with:

```sh
python3 verify_h11_patch.py \
  --source /tmp/h11-0.16.0 \
  --apply \
  --test \
  --python /tmp/mitmproxy-12.2.3/.venv/bin/python
```

The tests include exact-boundary, one-byte-over, trailing-body exclusion, and
slow-fragment cases. `--apply` intentionally mutates only the disposable clean
source directory supplied to the verifier.

## Reproducible wheel and image build

Install the hash-locked build tools, then build into an empty directory:

```sh
python3 -m pip install --require-hashes -r build-requirements.lock
python3 build_patched_wheels.py --output /tmp/patched-runtime
```

The builder checks out the exact mitmproxy commit, downloads and hashes the
exact h11 archive, applies both patches through the verifiers, sets a fixed
`SOURCE_DATE_EPOCH`, builds without dependency resolution or build isolation,
checks patched files inside both wheels, and writes
`patched-runtime-manifest.json` with artifact hashes and sizes. Repeating the
build with the same inputs must produce byte-identical wheels.

Build the runtime image from the proxy directory so `.dockerignore` and the
pinned Dockerfile are in scope:

```sh
docker build --file Dockerfile --tag maintainflow-interceptor:reviewed .
```

The Dockerfile pins the Python base image by digest, downloads the complete
runtime wheelhouse using `requirements.lock` with `--require-hashes`, installs
offline, force-replaces upstream h11 and mitmproxy with the patched wheels, and
runs `post_image_verify.py` during the build. The entrypoint repeats that check
on every process start. Verification checks installed versions, patch
sentinels, and exact installed-source hashes; image startup fails on drift.

## Internal mTLS contract

The interceptor's HTTPS upstream proxy must be the private Go policy dialer on
port 9443. These values are mandatory:

- `MF_DIALER_PROXY_URL=https://<dialer-name>:9443`
- `MF_DIALER_SERVER_NAME=<dialer-name>`
- `MF_DIALER_CLIENT_CERT_DIR=<absolute-directory>`
- `MF_DIALER_SERVER_CA_FILE=<absolute-CA-bundle>`
- `MF_DIALER_CLIENT_SPIFFE_ID=spiffe://maintainflow/interceptor`

The client directory must contain exactly one owner-only combined certificate
and unencrypted key named `<dialer-name>.pem`. Its leaf must be current, permit
client authentication, contain exactly the configured SPIFFE URI, and match the
private key. The server CA bundle must contain only current CA certificates and
no private key. The SPIFFE value must exactly equal the dialer's
`MF_DIALER_ALLOWED_CLIENT_SPIFFE_ID`; the CA must validate the dialer's server
certificate for `MF_DIALER_SERVER_NAME`. mitmproxy offers HTTP/1.1 ALPN for an
HTTPS upstream proxy, always sends the matching `Host` field, and has upstream
Basic authentication disabled, matching the dialer's canonical CONNECT and
mandatory ALPN checks.

`MF_AUDIT_FD` must name a writable, pre-opened descriptor at least 3. The
deployment supervisor owns opening and shipping that audit stream; ordinary
flow logging remains disabled.

This build is a security boundary, not proof of a live deployment. Certificate
issuance, secret mounting, audit-FD supervision, Fly-private connectivity,
Browserbase integration, and production canaries must still pass release
verification in the target environment.
