# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:shims.bzl", depot = "shims")

depot.alias(
    name = "fozzie",
    actual = "root//src/fozzie/engine:fozzie",
    tests = [":tests"],
)

depot.test_suite(
    name = "tests",
    tests = [
        "root//src/fozzie/engine:all-tests",
        "root//src/fozzie/examples/cxx:packet-fuzz",
        "root//src/fozzie/examples/cxx:packet-fuzz-coverage",
        "root//src/fozzie/examples/rust:decoder-fuzz",
        "root//src/fozzie/examples/rust:json-fuzz",
        "root//src/fozzie/kermit:tests",
        "root//src/fozzie/kermit/cli:tests",
        "root//src/fozzie/kermit/hegel:tests",
        "root//src/fozzie/runtime:tests",
    ],
    visibility = ["PUBLIC"],
)

# C and C++ fuzz tests run under ASan by default, so the ordinary suite above
# needs an ASan runtime. These targets gather the rest of the sanitizer
# coverage: the engine's own ASan fixtures and the opt-in Rust profile. This
# filegroup still analyzes the public transitions and materializes the
# instrumented final binaries.
depot.filegroup(
    name = "asan-builds",
    srcs = [
        "root//src/fozzie/examples/cxx:packet-fuzz",
        "root//src/fozzie/examples/rust:decoder-fuzz-asan",
    ],
    visibility = ["PUBLIC"],
)

depot.test_suite(
    name = "asan-tests",
    tests = [
        "root//src/fozzie/engine:asan-tests",
        "root//src/fozzie/examples/cxx:packet-fuzz",
        "root//src/fozzie/examples/rust:decoder-fuzz-asan",
    ],
    visibility = ["PUBLIC"],
)
