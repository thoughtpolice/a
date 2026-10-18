# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

"""Rules for running QEMU's system emulators from the build.

    load("@third-party//by-name/qe/qemu:defs.bzl", "qemu")

    qemu.run_qemu(
        name = "boot",
        system = "aarch64",
        args = ["-M", "virt", "-cpu", "max", "-kernel", "$(location :kernel)"],
    )

A run_qemu target is both something to `buck2 run` and a test: it runs the
emulator for `system` with -nographic and `args`, and passes when QEMU exits
with status 0.
"""

# The hosts QEMU's PACKAGE builds the emulators for. This rule is not a shim,
# which gives a target its package's compatibility, and is called from other
# packages, so it carries it itself: elsewhere a target would be compatible
# but its exec deps would have no execution platform.
_HOSTS = [
    "config//os:linux",
    "config//cpu:x86_64",
]

def _run_qemu_impl(ctx: AnalysisContext) -> list[Provider]:
    cmd = cmd_args([
        ctx.attrs.qemu[RunInfo],
        "-nographic",
    ] + ctx.attrs.args)

    return [
        DefaultInfo(),
        RunInfo(args = cmd),
        ExternalRunnerTestInfo(
            type = "custom",
            command = [cmd],
        ),
    ]

_run_qemu = rule(impl = _run_qemu_impl, attrs = {
    "args": attrs.list(attrs.arg()),
    "qemu": attrs.exec_dep(providers = [RunInfo]),
})

def _run_qemu_macro(name, system, **kwargs):
    _run_qemu(
        name = name,
        qemu = "third-party//by-name/qe/qemu:qemu-system-" + system,
        target_compatible_with = _HOSTS,
        **kwargs
    )

qemu = struct(
    run_qemu = _run_qemu_macro,
)
