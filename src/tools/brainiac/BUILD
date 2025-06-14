# SPDX-FileCopyrightText: © 2024-2025 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@toolchains//deno:defs.bzl", "deno")

ALL_TESTS = glob(["t/*_test.ts"])
ALL_TEST_TARGETS = map(lambda t: ":test-{}".format(t.replace("_test.ts", "").replace("t/", "").replace("_", "-")), ALL_TESTS)

deno.binary(
    name="brainiac",
    main="main.ts",
    type="run",
    config="deno.jsonc",
    permissions=["read", "write", "run", "env"],
    visibility=["PUBLIC"],
    tests = ALL_TEST_TARGETS,  # lint test is now automatically added
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
    for test_file in ALL_TESTS
]
