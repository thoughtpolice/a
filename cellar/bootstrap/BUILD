# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@cellar//bootstrap:actions.bzl", "command_test")
load("@cellar//bootstrap:defs.bzl", "export_file")

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
