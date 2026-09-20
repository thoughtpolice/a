# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:shims.bzl", "shims")
load(":defs.bzl", "default_platforms", "generate_platforms")

generate_platforms(default_platforms)

# The cpu each linux triple names in config//cpu/constraints. A linux triple
# describes a machine the prelude can also name with a cpu and an os, so these
# platforms move all three constraints together, the same way the transition in
# buck/shims/cross_binary.bzl does. Pinning cpu and os to the host instead
# strands every select keyed on them, and reindeer keys the third-party rust
# platform selects exactly there: a triple-only aarch64 configuration hands a
# crate the host's x86-64 sources and only falls over once the assembler reads
# them.
_LINUX_CPUS = {
    "aarch64": "arm64",
    "x86_64": "x86_64",
}

[
    shims.platform(
        name = "{arch}-linux-gnu".format(arch = arch),
        constraint_values = [
            "toolchains//cfg/target:target[{arch}-unknown-linux-gnu]".format(arch = arch),
            "config//cpu/constraints:{cpu}".format(cpu = cpu),
            "config//os/constraints:linux",
        ],
        deps = [":default"],
    )
    for arch, cpu in _LINUX_CPUS.items()
]

# Firmware is not a cpu/os pair the prelude can name, so the uefi platforms move
# only the triple and leave cpu and os on the host. The cxx and rust toolchains
# key the linker and the target flags on the triple, which is what actually
# differs here.
[
    shims.platform(
        name = "{arch}-uefi".format(arch = arch),
        constraint_values = [
            "toolchains//cfg/target:target[{arch}-unknown-uefi]".format(arch = arch),
        ],
        deps = [":default"],
    )
    for arch in [
        "aarch64",
        "x86_64",
    ]
]

# Guest code for wasm keeps the host's cpu and os constraints, exactly like the
# uefi platforms above: only the target triple moves, so every select keyed on
# config//os keeps answering for the machine the toolchain runs on.
shims.platform(
    name = "wasm32-unknown-unknown",
    constraint_values = [
        "toolchains//cfg/target:target[wasm32-unknown-unknown]",
    ],
    deps = [":default"],
)
