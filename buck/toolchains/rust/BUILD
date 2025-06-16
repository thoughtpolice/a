# SPDX-FileCopyrightText: © 2024-2025 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims/shims.bzl", depot = "shims")
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

rustc_target_triple = depot.select({
    'toolchains//cfg/target:x86_64-unknown-uefi': 'x86_64-unknown-uefi',
    'toolchains//cfg/target:x86_64-unknown-linux-gnu': 'x86_64-unknown-linux-gnu',
    'toolchains//cfg/target:aarch64-unknown-uefi': 'aarch64-unknown-uefi',
    'toolchains//cfg/target:aarch64-unknown-linux-gnu': 'aarch64-unknown-linux-gnu',
    'DEFAULT': '',
})

rustc_flags = depot.select({
    'mode//:debug': common_rustc_flags + [
        '-Cdebuginfo=2',
        '-Coverflow-checks=true',
    ],
    'mode//:release': common_rustc_flags + [
        # Overall, we want to aggressively optimize for size on the resulting
        # binary images for the kernel and UEFI apps.
        '-Cdebuginfo=none',
        '-Cstrip=debuginfo',
        '-Cdebug-assertions=false',
        '-Coverflow-checks=false',
    ] + depot.select({
        'toolchains//cfg/target:x86_64-unknown-uefi': [ '-Copt-level=z' ],
        'toolchains//cfg/target:aarch64-unknown-uefi': [ '-Copt-level=z' ],
        'DEFAULT': [ '-Copt-level=3' ],
    }),
})

system_rust_toolchain(
    name = 'rust',
    default_edition = '2021',
    rustc_target_triple = rustc_target_triple,
    rustc_flags = rustc_flags,
)
