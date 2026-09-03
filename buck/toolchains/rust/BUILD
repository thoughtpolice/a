# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@prelude//toolchains:rust.bzl", "system_rust_toolchain")
load("@root//buck/shims:shims.bzl", "shims")

# Panics unwind, rustc's default and what the prelude's toolchain assumes
# (panic_runtime = unwind). Hegel property tests depend on it: rejected cases
# and shrinking travel through unwinding. Targets whose specs abort, wasm32 and
# UEFI, keep aborting, and Fozzie harness binaries opt back into
# -Cpanic=abort so a panic is a finding.
common_rustc_flags = [
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
    "toolchains//cfg/target:target[wasm32-unknown-unknown]": "wasm32-unknown-unknown",
})

# The wasm32 target links with the cxx toolchain's linker like every other
# triple, and that linker is wasm-ld there; naming the flavor keeps rustc
# from guessing it from the wrapper script's file name.
target_rustc_flags = shims.select({
    "toolchains//cfg/target:target[wasm32-unknown-unknown]": ["-Clinker-flavor=wasm-ld"],
    "DEFAULT": [],
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
    # Level 3 instruments every edge, the same coverage the C++ flags ask
    # for; level 4 would also instrument indirect call sites, which call
    # __sanitizer_cov_trace_pc_indir, a callback the Fozzie runtime does not
    # define, so any Rust target with dynamic dispatch would fail to link.
    "-Cpasses=sancov-module",
    "-Cllvm-args=-sanitizer-coverage-level=3",
    "-Cllvm-args=-sanitizer-coverage-inline-8bit-counters",
    "-Cllvm-args=-sanitizer-coverage-pc-table",
    "-Cllvm-args=-sanitizer-coverage-trace-compares",
    "--cfg=fuzzing",
]

fozzie_asan_rustc_flags = fozzie_rustc_flags + [
    # The Rust code is instrumented by rustc, while the final clang++ linker
    # invocation owns the one compiler-rt instance for mixed-language targets.
    "-Zsanitizer=address",
    "-Zexternal-clangrt",
    "--cfg=fozzie_asan",
]

instrumentation_rustc_flags = shims.select({
    "toolchains//cfg/instrumentation:instrumentation[none]": [],
    "toolchains//cfg/instrumentation:instrumentation[fozzie]": fozzie_rustc_flags,
    "toolchains//cfg/instrumentation:instrumentation[fozzie-asan]": fozzie_asan_rustc_flags,
})

rustc_flags = target_rustc_flags + shims.select({
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
