# SPDX-FileCopyrightText: © 2024-2025 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:shims.bzl", "shims")
load("@prelude//toolchains:rust.bzl", "system_rust_toolchain")

common_rustc_flags = [
    # Always abort on panic; do this in tests, too
    '-Cpanic=abort',
    '-Zpanic_abort_tests',

    # don't use the parallel frontend; buck2 isn't jobserver aware, and so
    # this can lead to N processes using N threads a piece, oversubscribing
    # the CPU <https://github.com/facebook/buck2/issues/653>
    '-Zthreads=1',

    # codegen-units=1 improves overall size and performance of generated code
    '-Ccodegen-units=1',
]

rustc_target_triple = shims.select({
    'toolchains//cfg/target:target[x86_64-unknown-uefi]': 'x86_64-unknown-uefi',
    'toolchains//cfg/target:target[x86_64-unknown-linux-gnu]': 'x86_64-unknown-linux-gnu',
    'toolchains//cfg/target:target[aarch64-unknown-uefi]': 'aarch64-unknown-uefi',
    'toolchains//cfg/target:target[aarch64-unknown-linux-gnu]': 'aarch64-unknown-linux-gnu',
    'toolchains//cfg/target:target[aarch64-apple-darwin]': 'aarch64-apple-darwin',
})

rustc_flags = shims.select({
    'mode//:build-mode[debug]': common_rustc_flags + [
        '-Cdebuginfo=2',
        '-Coverflow-checks=true',
    ],
    'mode//:build-mode[release]': common_rustc_flags + [
        # Overall, we want to aggressively optimize for size on the resulting
        # binary images for the kernel and UEFI apps.
        '-Cdebuginfo=none',
        '-Cstrip=debuginfo',
        '-Cdebug-assertions=false',
        '-Coverflow-checks=false',
    ] + shims.select({
        'toolchains//cfg/target:target[x86_64-unknown-uefi]': [ '-Copt-level=z' ],
        'toolchains//cfg/target:target[aarch64-unknown-uefi]': [ '-Copt-level=z' ],
        'DEFAULT': [],
    }),
})

system_rust_toolchain(
    name = 'rust',
    default_edition = '2021',
    rustc_target_triple = rustc_target_triple,
    rustc_flags = rustc_flags,
)
