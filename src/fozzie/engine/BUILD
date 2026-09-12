# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:shims.bzl", depot = "shims")

ENGINE_DEPS = [
    "third-party//rust:anyhow",
    "third-party//rust:base64",
    "third-party//rust:blake3",
    "third-party//rust:clap",
    "third-party//rust:crossterm",
    "third-party//rust:libc",
    "third-party//rust:memmap2",
    "third-party//rust:ratatui",
    "third-party//rust:serde",
    "third-party//rust:serde_json",
    "third-party//rust:tempfile",
    "third-party//rust:unicode-width",
]

# The C fixtures below sit outside the fuzz transition and spell out their own
# instrumentation and link flags. On Linux, lld keeps the SanitizerCoverage PC
# tables the runtime consumes and the binaries carry their own libgcc and
# libstdc++; Darwin's linker keeps the tables by itself, rejects
# -static-libgcc, and ships ASan only as a dylib.
TARGET_LINKER_FLAGS = depot.select({
    "config//os:linux": [
        "-fuse-ld=lld",
        "-static-libgcc",
        "-static-libstdc++",
    ],
    "DEFAULT": [],
})

ASAN_TARGET_LINKER_FLAGS = TARGET_LINKER_FLAGS + ["-fsanitize=address"] + depot.select({
    "config//os:linux": ["-static-libsan"],
    "DEFAULT": [],
})

depot.rust_library(
    name = "engine-lib",
    srcs = glob(
        ["**/*.rs"],
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
        ["**/*.rs"],
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
    linker_flags = TARGET_LINKER_FLAGS,
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
    deps = [
        "third-party//by-name/mi/mimalloc:rust",
        "third-party//rust:libc",
        "third-party//rust:serde_json",
        "third-party//rust:tempfile",
    ],
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
    linker_flags = TARGET_LINKER_FLAGS,
    deps = ["root//src/fozzie/runtime:runtime"],
)

depot.cxx_binary(
    name = "executor-asan-test-target",
    srcs = ["asan_test_target.c"],
    compiler_flags = [
        "-std=c11",
        "-O2",
        "-fsanitize=address",
        "-fsanitize-coverage=inline-8bit-counters,pc-table,trace-cmp",
    ],
    link_style = "static",
    linker_flags = ASAN_TARGET_LINKER_FLAGS,
    deps = ["root//src/fozzie/runtime:runtime"],
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

depot.write_file(
    name = "exit-zero-seed",
    contents = ["EXIT0"],
)

depot.write_file(
    name = "exit-reserved-seed",
    contents = ["EXIT70"],
)

depot.write_file(
    name = "fork-crash-seed",
    contents = ["FORKCRASH"],
)

depot.write_file(
    name = "asan-underflow-seed",
    contents = ["U"],
)

depot.write_file(
    name = "asan-overflow-seed",
    contents = ["O"],
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
        "--expect-kind",
        "crash",
    ],
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
        "--expect-kind",
        "hang",
    ],
)

depot.command_test(
    name = "executor-exit-zero-test",
    cmd = [
        "$(exe :fozzie)",
        "replay",
        "--target",
        "$(exe :executor-test-target)",
        "--input",
        "$(location :exit-zero-seed)",
        "--expect-finding",
        "--expect-kind",
        "exit",
        "--expect-code",
        "0",
    ],
)

depot.command_test(
    name = "executor-exit-reserved-test",
    cmd = [
        "$(exe :fozzie)",
        "replay",
        "--target",
        "$(exe :executor-test-target)",
        "--input",
        "$(location :exit-reserved-seed)",
        "--expect-finding",
        "--expect-kind",
        "exit",
        "--expect-code",
        "70",
    ],
)

depot.command_test(
    name = "executor-fork-crash-test",
    cmd = [
        "$(exe :fozzie)",
        "replay",
        "--target",
        "$(exe :executor-test-target)",
        "--input",
        "$(location :fork-crash-seed)",
        "--timeout-ms",
        # Leave room for fork, crash handling, and scheduling on busy CI hosts.
        "5000",
        "--expect-finding",
        "--expect-kind",
        "crash",
    ],
)

# The registry lives under the caller's state directory, which a
# command_test cannot redirect; the empty screen is the one case that needs
# no campaign at all.
depot.command_test(
    name = "tui-once-empty-test",
    cmd = [
        "$(exe :fozzie)",
        "tui",
        "--once",
        "--no-registry",
        "--width",
        "80",
        "--height",
        "24",
    ],
)

depot.test_suite(
    name = "all-tests",
    tests = [
        ":executor-exit-reserved-test",
        ":executor-exit-zero-test",
        ":executor-finding-test",
        ":executor-fork-crash-test",
        ":executor-smoke-test",
        ":executor-timeout-test",
        ":regression-tests",
        ":tests",
        ":tui-once-empty-test",
    ],
)

depot.command_test(
    name = "executor-asan-underflow-test",
    cmd = [
        "$(exe :fozzie)",
        "replay",
        "--target",
        "$(exe :executor-asan-test-target)",
        "--sanitizer",
        "address",
        "--input",
        "$(location :asan-underflow-seed)",
        "--max-input",
        "63",
        "--expect-finding",
        "--expect-kind",
        "crash",
        "--expect-sanitizer",
        "address",
    ],
)

depot.command_test(
    name = "executor-asan-overflow-test",
    cmd = [
        "$(exe :fozzie)",
        "replay",
        "--target",
        "$(exe :executor-asan-test-target)",
        "--sanitizer",
        "address",
        "--input",
        "$(location :asan-overflow-seed)",
        "--max-input",
        "63",
        "--expect-finding",
        "--expect-kind",
        "crash",
        "--expect-sanitizer",
        "address",
    ],
)

depot.test_suite(
    name = "asan-tests",
    tests = [
        ":executor-asan-overflow-test",
        ":executor-asan-underflow-test",
    ],
)
