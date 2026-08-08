# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:shims.bzl", "shims")
load(":defs.bzl", "get_default_target_triple")

# Every triple a target may be built for. A value here is not a promise that
# some toolchain can reach it today: it is the name the selects downstream key
# off, and one has to exist before anything can be pointed at it. The darwin
# and windows triples beyond the host's own arrive by transition, from
# buck/shims/cross_binary.bzl.
shims.constraint(
    name = "target",
    default = get_default_target_triple(),
    values = [
        "x86_64-unknown-uefi",
        "x86_64-unknown-linux-gnu",
        "x86_64-apple-darwin",
        "x86_64-pc-windows-msvc",
        "aarch64-unknown-uefi",
        "aarch64-unknown-linux-gnu",
        "aarch64-apple-darwin",
        "aarch64-pc-windows-msvc",
    ],
)
