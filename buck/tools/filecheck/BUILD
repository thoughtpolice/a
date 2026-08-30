# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:shims.bzl", "shims")

SRCS = [
    "check.go",
    "checker.go",
    "cli.go",
    "diag.go",
    "diff.go",
    "dump.go",
    "features.go",
    "iobuf.go",
    "lit.go",
    "main.go",
    "numeric.go",
    "pattern.go",
    "shell.go",
]

TEST_SRCS = [
    "checker_test.go",
    "cli_test.go",
    "diff_test.go",
    "features_test.go",
    "lit_test.go",
    "shell_test.go",
]

shims.go_binary(
    name = "filecheck",
    srcs = SRCS,
    cgo_enabled = False,
    link_mode = "internal",
    tests = [
        ":self-tests",
        ":unit",
        ":version-check",
    ],
    visibility = ["PUBLIC"],
)

shims.go_test(
    name = "unit",
    srcs = SRCS + TEST_SRCS,
    cgo_enabled = False,
)

# A stand-in compiler for the self-tests below; see tests/toy/main.go.
shims.go_binary(
    name = "toy",
    srcs = ["tests/toy/main.go"],
    cgo_enabled = False,
    link_mode = "internal",
    tests = [":toy-version"],
)

shims.export_file(
    name = "toy-input-data",
    src = "tests/inputs/hello.txt",
)

shims.command(
    name = "toy-with-input",
    cmd = [
        "$(exe :toy)",
        "$(location :toy-input-data)",
    ],
)

# Every .test file is one case; every RUN: line in it reports a result.
shims.filecheck.lit(
    name = "self-tests",
    srcs = glob(["tests/*.test"]),
    data = glob(["tests/inputs/*"]),
    defines = {
        "greeting": "hello from BUILD",
        "input": "$(location :toy-input-data)",
    },
    features = ["self-tests"],
    tools = {
        "toy": ":toy",
        "toy_input": ":toy-with-input",
    },
)

shims.filecheck.test(
    name = "version-check",
    args = ["version"],
    check = "tests/version.check",
    dep = ":filecheck",
)

shims.filecheck.test(
    name = "toy-version",
    args = ["--version"],
    check = "tests/toy-version.check",
    dep = ":toy",
)
