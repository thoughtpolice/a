# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:shims.bzl", depot = "shims")

depot.test_suite(
    name = "tests",
    tests = [
        "root//src/fozzie/engine:all-tests",
        "root//src/fozzie/examples/cxx:packet-fuzz",
        "root//src/fozzie/examples/rust:decoder-fuzz",
        "root//src/fozzie/runtime:tests",
    ],
    visibility = ["PUBLIC"],
)
