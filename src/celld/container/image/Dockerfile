# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

# The image the container and sandbox examples and integration tests run:
# busybox (musl) pinned by its multi-platform index digest, so `celld dev`
# builds it for the host and `celld deploy` for linux/amd64 without RUN
# steps or emulation. Busybox has everything the sandbox scripts use
# (realpath, find, stat, mkfifo, setsid, env) plus httpd for the examples'
# servers. The container's own process only keeps it alive; work happens
# through exec.
#
# celld drops CAP_CHOWN, so root in the container cannot give a directory
# to the sandbox user: the image does. BuildKit creates a WORKDIR owned by
# the current USER, so /workspace belongs to 1000:1000 without a RUN step.
FROM docker.io/library/busybox:1.37.0-musl@sha256:5cec3fc171c87218698e85a52af7087de727372aae264a787b8112901a5b0092
USER 1000:1000
WORKDIR /workspace
CMD ["tail", "-f", "/dev/null"]
