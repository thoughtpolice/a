# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@prelude//toolchains:rust.bzl", "system_rust_toolchain")
load("@root//buck/shims:shims.bzl", "shims")

common_rustc_flags = [
    # Always abort on panic; do this in tests, too
    "-Cpanic=abort",
    "-Zpanic_abort_tests",

    # don't use the parallel frontend; buck2 isn't jobserver aware, and so
    # this can lead to N processes using N threads a piece, oversubscribing
    # the CPU <https://github.com/facebook/buck2/issues/653>
    "-Zthreads=1",

    # codegen-units=1 improves overall size and performance of generated code
    "-Ccodegen-units=1",

    # always produce stack frames for perf analysis
    "-Cforce-frame-pointers=yes",

    # we need this for tokio-console and other things
    "--cfg=tokio_unstable",
]

# Total over the triples in buck/toolchains/cfg/target, deliberately: a triple
# this does not name fails to configure, which is a worse error than the one a
# rustc without that target's std gives back, and lands on whoever crossed to
# it rather than on the platform they crossed to.
rustc_target_triple = shims.select({
    "toolchains//cfg/target:target[x86_64-unknown-uefi]": "x86_64-unknown-uefi",
    "toolchains//cfg/target:target[x86_64-unknown-linux-gnu]": "x86_64-unknown-linux-gnu",
    "toolchains//cfg/target:target[x86_64-apple-darwin]": "x86_64-apple-darwin",
    "toolchains//cfg/target:target[x86_64-pc-windows-msvc]": "x86_64-pc-windows-msvc",
    "toolchains//cfg/target:target[aarch64-unknown-uefi]": "aarch64-unknown-uefi",
    "toolchains//cfg/target:target[aarch64-unknown-linux-gnu]": "aarch64-unknown-linux-gnu",
    "toolchains//cfg/target:target[aarch64-apple-darwin]": "aarch64-apple-darwin",
    "toolchains//cfg/target:target[aarch64-pc-windows-msvc]": "aarch64-pc-windows-msvc",
})

fozzie_rustc_flags = [
    # Keep fuzz builds representative of optimized production code while
    # retaining enough information to symbolize coverage and diagnostics.
    "-Copt-level=3",
    "-Cdebuginfo=line-tables-only",
    "-Cdebug-assertions=false",
    "-Coverflow-checks=false",
    "-Cforce-frame-pointers=yes",

    # rustc exposes LLVM SanitizerCoverage through the sancov module pass.
    "-Cpasses=sancov-module",
    "-Cllvm-args=-sanitizer-coverage-level=4",
    "-Cllvm-args=-sanitizer-coverage-inline-8bit-counters",
    "-Cllvm-args=-sanitizer-coverage-pc-table",
    "-Cllvm-args=-sanitizer-coverage-trace-compares",
    "--cfg=fuzzing",
]

instrumentation_rustc_flags = shims.select({
    "toolchains//cfg/instrumentation:instrumentation[none]": [],
    "toolchains//cfg/instrumentation:instrumentation[fozzie]": fozzie_rustc_flags,
    # ASan runtime support will be added separately. Keep this configuration
    # useful for coverage-only builds until that runtime is available.
    "toolchains//cfg/instrumentation:instrumentation[fozzie-asan]": fozzie_rustc_flags,
})

rustc_flags = shims.select({
    "mode//:build-mode[debug]": common_rustc_flags + [
        "-Cdebuginfo=2",
        "-Coverflow-checks=true",
    ],
    "mode//:build-mode[release]": common_rustc_flags + [
        "-Cdebuginfo=line-tables-only",
        "-Cdebug-assertions=false",
        "-Coverflow-checks=false",
    ] + shims.select({
        "toolchains//cfg/target:target[x86_64-unknown-uefi]": ["-Copt-level=z"],
        "toolchains//cfg/target:target[aarch64-unknown-uefi]": ["-Copt-level=z"],
        "DEFAULT": ["-Copt-level=3"],
    }),
}) + instrumentation_rustc_flags

system_rust_toolchain(
    name = "rust",
    default_edition = "2021",
    rustc_flags = rustc_flags,
    rustc_target_triple = rustc_target_triple,
)
