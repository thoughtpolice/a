# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:shims.bzl", depot = "shims")

depot.go_binary(
    name = "httpd",
    srcs = ["main.go"],
    cgo_enabled = False,
    link_mode = "internal",
)
