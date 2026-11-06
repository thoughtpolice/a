# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:shims.bzl", depot = "shims")
load("@root//src/fozzie:defs.bzl", "rust_fuzz_binary")

SRCS = glob(
    ["*.rs"],
    exclude = [
        "test_*.rs",
        "tests.rs",
    ],
)

DEPS = [
    "//src/crates/reapi-cas",
    "third-party//rust:anyhow",
    "third-party//rust:futures",
    "third-party//rust:libc",
    "third-party//rust:tokio",
]

# Fault injection is compiled out of the library; `reflink-cache-faults`
# is the same crate with it on, for tests and fuzzers here and in its
# users.
depot.rust_library(
    name = "reflink-cache",
    srcs = SRCS,
    crate_root = "lib.rs",
    tests = [":tests"],
    visibility = ["PUBLIC"],
    deps = DEPS + ["//src/crates/faultline:disabled"],
)

depot.rust_library(
    name = "reflink-cache-faults",
    srcs = SRCS,
    crate = "reflink_cache",
    crate_root = "lib.rs",
    visibility = ["PUBLIC"],
    deps = DEPS + ["//src/crates/faultline"],
)

depot.rust_test(
    name = "tests",
    srcs = glob(["*.rs"]),
    crate_root = "lib.rs",
    deps = DEPS + [
        "third-party//rust:hegeltest",
        "third-party//rust:tempfile",
        "third-party//rust:thiserror",
        "//src/crates/faultline",
    ],
)

# Fuzzing with fozzie: the input drives the state machine the crash tests
# use. It runs as a short smoke test from its seed corpus; for a longer
# campaign, give it a work directory:
#
#   buck2 run //src/gonzo/reflink-cache:fuzz-machine -- \
#       --workdir /var/tmp/reflink-cache-machine --jobs 2 --duration 600
depot.rust_binary(
    name = "fuzz-seeds",
    srcs = ["fuzz/seeds.rs"],
    crate_root = "fuzz/seeds.rs",
)

depot.genrule(
    name = "fuzz-seeds-machine",
    out = "machine",
    cmd = "$(exe :fuzz-seeds) $OUT",
)

rust_fuzz_binary(
    name = "fuzz-machine",
    srcs = [
        "fuzz/machine.rs",
        "test_machine.rs",
    ],
    corpus = [":fuzz-seeds-machine"],
    crate_root = "fuzz/machine.rs",
    duration_seconds = 0,
    jobs = 1,
    max_input = 1 << 14,
    runs = 512,
    timeout_ms = 10000,
    deps = [
        "third-party//rust:anyhow",
        "third-party//rust:arbitrary",
        "third-party//rust:futures",
        "third-party//rust:libc",
        "third-party//rust:tokio",
        ":reflink-cache-faults",
        "//src/crates/faultline",
        "//src/crates/reapi-cas",
    ],
)
