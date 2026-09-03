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
    # Mach-O has no undefined weak reference that resolves to null: each
    # symbol the runtime declares FOZZIE_OPTIONAL must be named as allowed to
    # stay undefined on the final link, where dyld then binds it to null when
    # nothing defines it.
    exported_linker_flags = depot.select({
        "config//os:macos": [
            "-Wl,-U,_LLVMFuzzerInitialize",
            "-Wl,-U,___asan_poison_memory_region",
            "-Wl,-U,___asan_unpoison_memory_region",
        ],
        "DEFAULT": [],
    }),
    header_namespace = "fozzie/runtime",
    link_whole = True,
    preferred_linkage = "static",
    visibility = ["PUBLIC"],
)

depot.cxx_binary(
    name = "runtime-test-bin",
    srcs = ["runtime_test.c"],
    compiler_flags = [
        "-std=c11",
        "-fno-sanitize-coverage=inline-8bit-counters,pc-table,trace-cmp",
    ],
    deps = [":runtime"],
)

depot.command_test(
    name = "runtime-test",
    cmd = ["$(exe :runtime-test-bin)"],
)

depot.test_suite(
    name = "tests",
    tests = [":runtime-test"],
)
