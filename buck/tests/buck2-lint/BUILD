# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:shims.bzl", "shims")

SOURCE_DIRS = [
    "src",
    # FIXME (aseipp): can't list buck/prelude here, since it might have extra
    # junk inside if it's expanded.
    "buck/bin",
    "buck/mode",
    "buck/platforms",
    "buck/shims",
    "buck/tests",
    "buck/third-party",
    "buck/toolchains",
]

# The Starlark file names the linter reads under each of SOURCE_DIRS. Deriving
# the determinator patterns from that same list keeps the two descriptions of
# this test's scope from drifting apart.
STARLARK_FILES = [
    "BUILD",
    "BUCK",
    "PACKAGE",
    "*.bzl",
    "*.bxl",
]

shims.command_test(
    name = "lint",
    ci_srcs = [
        "{}/**/{}".format(directory, name)
        for directory in SOURCE_DIRS
        for name in STARLARK_FILES
    ],
    cmd = [
        "dotslash",
        "$(location //buck/bin:buck2)",
        "--isolation-dir",
        ".buck2-lint-tests",
        "starlark",
        "lint",
    ] + SOURCE_DIRS,
)
