# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@cellar//bootstrap:actions.bzl", "command_test")
load("@cellar//bootstrap:defs.bzl", "export_file")
load("@cellar//bootstrap:source.bzl", "write_file")
load("@cellar//bootstrap/platforms:defs.bzl", "alias")

# The default installation follows the client architecture. An explicit
# --modifier changes the requested output, while fixed bootstrap predecessors
# keep their own configurations through transitions and exec dependencies.
alias(
    name = "toolchain",
    actual = select({
        "cellar//bootstrap/platforms:amd64": "cellar//bootstrap/stage1/llvm:toolchain",
        "cellar//bootstrap/platforms:arm64": "cellar//bootstrap/stage2/aarch64/llvm:toolchain",
    }),
    modifiers = [
        "cellar//bootstrap/platforms:linux",
        "cellar//bootstrap/platforms:arm64" if host_info().arch.is_aarch64 else "cellar//bootstrap/platforms:amd64",
    ],
)

# What a checking action writes once every check passes; see result_test.
write_file(
    name = "passed",
    content = "passed\n",
)

# The audit scripts' tests run with the bootstrapped Python, as build
# actions do, so they need nothing from the host.
[
    [
        export_file(name = "test-{}.py".format(name)),
        command_test(
            name = name + "-test",
            args = ["$(location :test-{}.py)".format(name)],
            inputs = [name + ".py"],
            tool = "cellar//bootstrap/stage1/python:python3",
        ),
    ]
    for name in [
        "audit-trace",
        "audit-installation",
    ]
]
