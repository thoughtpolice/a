# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@toolchains//deno:defs.bzl", "deno")

deno.binary(
    name = "build-report",
    main = "main.ts",
    permissions = [
        "read",
        "write",
    ],
    type = "run",
    visibility = ["PUBLIC"],
)
