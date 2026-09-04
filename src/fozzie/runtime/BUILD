# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:shims.bzl", depot = "shims")

depot.cxx_library(
    name = "runtime",
    srcs = ["runtime.c"],
    compiler_flags = [
        "-std=c11",
        "-fno-sanitize=address",
        "-fno-sanitize-coverage=inline-8bit-counters,pc-table,trace-cmp",
    ],
    exported_headers = [
        "protocol.h",
        "target.h",
    ],
    header_namespace = "fozzie/runtime",
    link_whole = True,
    preferred_linkage = "static",
    target_compatible_with = ["config//os:linux"],
    visibility = ["PUBLIC"],
)

depot.cxx_binary(
    name = "runtime-test-bin",
    srcs = ["runtime_test.c"],
    compiler_flags = [
        "-std=c11",
        "-fno-sanitize-coverage=inline-8bit-counters,pc-table,trace-cmp",
    ],
    target_compatible_with = ["config//os:linux"],
    deps = [":runtime"],
)

depot.command_test(
    name = "runtime-test",
    cmd = ["$(exe :runtime-test-bin)"],
    target_compatible_with = ["config//os:linux"],
)

depot.test_suite(
    name = "tests",
    tests = [":runtime-test"],
)
