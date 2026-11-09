# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

# protoc and the well-known-type protos it imports, built from source by
# third-party//by-name/pr/protobuf. See protoc_env() in defs.bzl.

load("@root//buck/shims:shims.bzl", "shims")

PROTOBUF = "third-party//by-name/pr/protobuf"

shims.alias(
    name = "protoc",
    actual = PROTOBUF + ":protoc",
    visibility = ["PUBLIC"],
)

shims.alias(
    name = "include",
    actual = PROTOBUF + ":well-known-protos",
    visibility = ["PUBLIC"],
)
