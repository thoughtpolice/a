# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:shims.bzl", depot="shims")

# Chainguard glibc-dynamic base images for building application containers
# https://images.chainguard.dev/directory/image/glibc-dynamic

depot.oci.pull(
    name = "chainguard_glibc_dynamic_arm64",
    image = "cgr.dev/chainguard/glibc-dynamic@sha256:def5ae4cdeef935b2d4b55b03eccd695ec114b029e46b8515b04032a4cdd3909",
    platform = "linux/arm64",
    visibility = ["PUBLIC"],
)

depot.oci.pull(
    name = "chainguard_glibc_dynamic_amd64",
    image = "cgr.dev/chainguard/glibc-dynamic@sha256:def5ae4cdeef935b2d4b55b03eccd695ec114b029e46b8515b04032a4cdd3909",
    platform = "linux/amd64",
    visibility = ["PUBLIC"],
)
