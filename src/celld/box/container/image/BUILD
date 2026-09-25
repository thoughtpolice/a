# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:shims.bzl", depot = "shims")

# The build context of the examples' and integration tests' image, for
# `celld.project(container_context = ..., containers = [{"image":
# "container/Dockerfile", ...}])`. Building a project copies it; only
# `celld dev` and `celld deploy` (dry runs included) invoke Docker.
depot.filegroup(
    name = "image",
    srcs = ["Dockerfile"],
    visibility = ["PUBLIC"],
)
