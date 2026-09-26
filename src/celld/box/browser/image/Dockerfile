# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

# Multi-platform Debian index: native arm64 development and amd64 deployment.
# The minimal native headless shell avoids a full Chrome desktop, Node service,
# or Playwright download. Direct packages are version-pinned; transitive Debian
# dependencies still follow the signed distribution repositories. Release a
# reviewed image digest/SBOM, not an assumption that this context is hermetic.
FROM docker.io/library/debian:trixie-slim@sha256:a99cfc517144bc59b1978475ec53b46ecabec7e43635402ee5b77cc54cd1b20a

RUN apt-get update \
    && apt-get install -y --no-install-recommends chromium-headless-shell=154.0.8037.92-1~deb13u1 \
    && rm -rf /var/lib/apt/lists/*

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        busybox-static=1:1.37.0-6+b9 \
        ca-certificates=20250419 \
        socat=1.8.0.3-1+deb13u1 \
    && test -x /bin/dmesg \
    && test -x /bin/head \
    && test -x /bin/grep \
    && test -x /usr/bin/env \
    && test -x /usr/bin/setsid \
    && rm -rf /var/lib/apt/lists/*

COPY --chmod=0555 celld-browser /usr/local/bin/celld-browser

USER 1000:1000
WORKDIR /workspace
ENV HOME=/workspace
CMD ["tail", "-f", "/dev/null"]
