# SPDX-FileCopyrightText: © 2024-2025 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@toolchains//deno:defs.bzl", "deno")

deno.binary(
    name="brainiac",
    main="main.ts",
    type="run",
    config="deno.jsonc",
    permissions=["read", "write", "run", "env"],
    visibility=["PUBLIC"],
)

[
    deno.test(
        name="test-{}".format(
            test_file.replace("_test.ts", "").replace("t/", "").replace("_", "-")
        ),
        srcs=[test_file],
        config="deno.jsonc",
        permissions=["read", "write", "run", "env"],
    )
    for test_file in glob(["t/*_test.ts"])
]
