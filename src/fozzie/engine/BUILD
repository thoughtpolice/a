# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:shims.bzl", depot = "shims")

ENGINE_DEPS = [
    "third-party//rust:anyhow",
    "third-party//rust:base64",
    "third-party//rust:blake3",
    "third-party//rust:clap",
    "third-party//rust:crossbeam-channel",
    "third-party//rust:memmap2",
    "third-party//rust:serde",
    "third-party//rust:serde_json",
    "third-party//rust:tempfile",
]

depot.rust_library(
    name = "engine-lib",
    srcs = glob(
        ["*.rs"],
        exclude = [
            "main.rs",
            "regression_test.rs",
        ],
    ),
    crate = "fozzie_engine",
    crate_root = "lib.rs",
    visibility = ["PUBLIC"],
    deps = ENGINE_DEPS,
)

depot.rust_binary(
    name = "fozzie",
    srcs = ["main.rs"],
    visibility = ["PUBLIC"],
    deps = [
        "third-party//by-name/mi/mimalloc:rust",
        ":engine-lib",
    ],
)

depot.rust_test(
    name = "tests",
    srcs = glob(
        ["*.rs"],
        exclude = [
            "main.rs",
            "regression_test.rs",
        ],
    ),
    crate = "fozzie_engine",
    crate_root = "lib.rs",
    deps = ENGINE_DEPS + [
        "third-party//by-name/mi/mimalloc:rust",
    ],
)

depot.cxx_binary(
    name = "executor-test-target",
    srcs = ["test_target.c"],
    compiler_flags = [
        "-std=c11",
        "-O2",
        "-fsanitize-coverage=inline-8bit-counters,pc-table,trace-cmp",
    ],
    link_style = "static",
    linker_flags = [
        "-fuse-ld=lld",
        "-static-libgcc",
        "-static-libstdc++",
    ],
    target_compatible_with = ["config//os:linux"],
    deps = ["root//src/fozzie/runtime:runtime"],
)

depot.cxx_binary(
    name = "regression-target",
    srcs = ["regression_target.c"],
    compiler_flags = [
        "-std=c11",
        "-O2",
        "-fsanitize-coverage=inline-8bit-counters,pc-table,trace-cmp",
    ],
    link_style = "static",
    linker_flags = [
        "-fuse-ld=lld",
        "-static-libgcc",
        "-static-libstdc++",
    ],
    target_compatible_with = ["config//os:linux"],
    deps = ["root//src/fozzie/runtime:runtime"],
)

depot.rust_test(
    name = "regression-tests",
    srcs = ["regression_test.rs"],
    crate_root = "regression_test.rs",
    run_env = {
        "FOZZIE_TEST_ENGINE": "$(location :fozzie)",
        "FOZZIE_TEST_TARGET": "$(location :executor-test-target)",
        "FOZZIE_REGRESSION_TARGET": "$(location :regression-target)",
    },
    target_compatible_with = ["config//os:linux"],
    deps = [
        "third-party//by-name/mi/mimalloc:rust",
        "third-party//rust:libc",
        "third-party//rust:serde_json",
        "third-party//rust:tempfile",
    ],
)

depot.write_file(
    name = "smoke-seed",
    contents = ["ordinary seed"],
)

depot.write_file(
    name = "crash-seed",
    contents = ["B"],
)

depot.write_file(
    name = "hang-seed",
    contents = ["HANG"],
)

depot.command_test(
    name = "executor-smoke-test",
    cmd = [
        "$(exe :fozzie)",
        "fuzz",
        "--target",
        "$(exe :executor-test-target)",
        "--corpus",
        "$(location :smoke-seed)",
        "--runs",
        "32",
        "--duration",
        "0",
        "--jobs",
        "2",
        "--seed",
        "1234",
    ],
    target_compatible_with = ["config//os:linux"],
)

depot.command_test(
    name = "executor-finding-test",
    cmd = [
        "$(exe :fozzie)",
        "replay",
        "--target",
        "$(exe :executor-test-target)",
        "--input",
        "$(location :crash-seed)",
        "--expect-finding",
    ],
    target_compatible_with = ["config//os:linux"],
)

depot.command_test(
    name = "executor-timeout-test",
    cmd = [
        "$(exe :fozzie)",
        "replay",
        "--target",
        "$(exe :executor-test-target)",
        "--input",
        "$(location :hang-seed)",
        "--timeout-ms",
        "25",
        "--expect-finding",
    ],
    target_compatible_with = ["config//os:linux"],
)

depot.test_suite(
    name = "all-tests",
    tests = [
        ":executor-finding-test",
        ":executor-smoke-test",
        ":executor-timeout-test",
        ":regression-tests",
        ":tests",
    ],
)
