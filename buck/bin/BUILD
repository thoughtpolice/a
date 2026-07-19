# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:shims.bzl", "shims")

FILE_LIST = glob(
    ["*"],
    exclude = [
        "BUILD",
        "PACKAGE",
    ],
)

[
    shims.export_file(
        name = file,
        src = file,
    )
    for file in FILE_LIST
]

[
    shims.run_test(
        name = "test-check-{}".format(file),
        args = [
            "$(location :{})".format(file),
        ],
        dep = "//buck/tools/check-dotslash-file:{}".format(
            "check-hashes" if not file.endswith(".exe") else "check-windows-shim",
        ),
    )
    for file in FILE_LIST
]

shims.test_suite(
    name = "tests",
    tests = [":test-check-{}".format(file) for file in FILE_LIST],
)
