# syntax=docker/dockerfile:1.7

ARG PYTHON_IMAGE=python:3.13.11-slim-trixie@sha256:2b9c9803c6a287cafa0a8c917211dddd23dcd2016f049690ee5219f5d3f1636e

FROM ${PYTHON_IMAGE} AS wheel-builder
ENV PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_NO_CACHE_DIR=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONHASHSEED=0
RUN apt-get update \
    && apt-get upgrade --yes \
    && apt-get install --yes --no-install-recommends ca-certificates git \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /src/interceptor
COPY interceptor/ ./
RUN python -m pip install --require-hashes -r build-requirements.lock
RUN mkdir -p /wheelhouse /patched \
    && python -m pip wheel \
      --only-binary=:all: \
      --no-deps \
      --require-hashes \
      --wheel-dir /wheelhouse \
      -r requirements.lock \
    && python build_patched_wheels.py --output /patched

FROM ${PYTHON_IMAGE} AS runtime
ENV HOME=/nonexistent \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_NO_CACHE_DIR=1
RUN apt-get update \
    && apt-get upgrade --yes \
    && apt-get purge --allow-remove-essential --yes util-linux liblastlog2-2 libsqlite3-0 \
    && rm -f /usr/local/lib/python3.13/lib-dynload/_sqlite3*.so \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 10001 maintainflow \
    && useradd --uid 10001 --gid 10001 --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin maintainflow
WORKDIR /opt/maintainflow/interceptor
COPY interceptor/requirements.lock ./requirements.lock
RUN --mount=from=wheel-builder,source=/wheelhouse,target=/wheelhouse,ro \
    --mount=from=wheel-builder,source=/patched,target=/patched,ro \
    python -m pip install \
      --no-index \
      --no-deps \
      --find-links=/wheelhouse \
      --require-hashes \
      -r requirements.lock \
    && python -m pip install \
      --no-index \
      --no-deps \
      --force-reinstall \
      /patched/h11-0.16.0-*.whl \
      /patched/mitmproxy-12.2.3-*.whl
COPY --chown=maintainflow:maintainflow interceptor/addons ./addons
COPY --chown=maintainflow:maintainflow interceptor/load_policy.py ./load_policy.py
COPY --chown=maintainflow:maintainflow interceptor/post_image_verify.py ./post_image_verify.py
COPY --chown=maintainflow:maintainflow interceptor/pinned-source.json ./pinned-source.json
COPY --chown=maintainflow:maintainflow interceptor/egress-init.sh ./egress-init.sh
COPY --from=wheel-builder --chown=maintainflow:maintainflow /patched/patched-runtime-manifest.json ./patched-runtime-manifest.json
RUN python post_image_verify.py --manifest pinned-source.json
USER 10001:10001
EXPOSE 8080
ENTRYPOINT ["/opt/maintainflow/interceptor/egress-init.sh"]
