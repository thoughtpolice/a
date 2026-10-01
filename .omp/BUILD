# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:shims.bzl", depot = "shims")
load("@toolchains//deno:defs.bzl", "deno")

deno.test(
    name = "test-tools",
    srcs = glob([
        "tests/*_test.ts",
        "lib/**/*.ts",
        "tools/*.ts",
        "skills/**/scripts/*.ts",
    ]),
    config = "deno.jsonc",
    data = ["deno.lock"],
    permissions = [
        "read",
        "write",
        "env",
        "run=mkfifo",
        "sys=homedir",
    ],
)

depot.test_suite(
    name = "tests",
    tests = [":test-tools"],
)
