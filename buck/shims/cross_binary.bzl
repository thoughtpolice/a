# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

"""Build another target for a specific cpu/os, regardless of the configuration
the caller is being built in.

Target modifiers cannot express this. Modifiers are applied top-down from the
target named on the command line, so a fan-out target that collects several
per-platform binaries overwrites the modifiers of everything beneath it: build
the collection and you get N identical copies of the host binary, with no error
to tell you so. An incoming-edge transition belongs to the target that declares
it and applies wherever that target is reached, including as a dependency.

The transition overlays cpu and os onto the incoming configuration rather than
replacing it, so unrelated constraints still flow down from the command line --
`buck2 build :some-fanout -m release` keeps release mode for every platform.
"""

load("@prelude//:paths.bzl", "paths")

# Constraint values the transition can select between. Extending these is just
# a matter of adding the name, as long as the toolchains being crossed to know
# how to map it.
CPUS = [
    "arm64",
    "x86_64",
]

OSES = [
    "linux",
    "macos",
    "windows",
]

_REFS = {
    "cpu_{}".format(cpu): "config//cpu/constraints:{}".format(cpu)
    for cpu in CPUS
} | {
    "os_{}".format(os): "config//os/constraints:{}".format(os)
    for os in OSES
}

def _cross_transition_impl(platform: PlatformInfo, refs: struct, attrs: struct) -> PlatformInfo:
    constraints = dict(platform.configuration.constraints)
    for ref in ["cpu_{}".format(attrs.cpu), "os_{}".format(attrs.os)]:
        value = getattr(refs, ref)[ConstraintValueInfo]
        constraints[value.setting.label] = value

    return PlatformInfo(
        # The prelude's cfg_name() keys off ovr_config// labels, which this repo
        # does not alias, so it would name every one of these "cfg:<empty>".
        label = "cfg:{cpu}-{os}".format(cpu = attrs.cpu, os = attrs.os),
        configuration = ConfigurationInfo(
            constraints = constraints,
            values = platform.configuration.values,
        ),
    )

_cross_transition = transition(
    impl = _cross_transition_impl,
    refs = _REFS,
    attrs = ["cpu", "os"],
)

def _cross_binary_impl(ctx: AnalysisContext) -> list[Provider]:
    outputs = ctx.attrs.actual[DefaultInfo].default_outputs
    if len(outputs) != 1:
        fail("{actual} must produce exactly one output, got {n}".format(
            actual = ctx.attrs.actual.label.raw_target(),
            n = len(outputs),
        ))

    # Take the extension from the wrapped target rather than deciding it here,
    # so ".exe" on windows follows whatever the underlying rule chose.
    _, ext = paths.split_extension(outputs[0].short_path)
    output = ctx.actions.copy_file(ctx.label.name + ext, outputs[0])

    return [
        DefaultInfo(default_output = output),
        RunInfo(args = cmd_args(output)),
    ]

cross_binary = rule(
    impl = _cross_binary_impl,
    cfg = _cross_transition,
    attrs = {
        "actual": attrs.dep(doc = "Target to rebuild for `cpu`/`os`."),
        "cpu": attrs.enum(CPUS),
        "os": attrs.enum(OSES),
    },
    doc = """Rebuild `actual` for a given cpu/os and republish its output under
    this target's name.

    Only useful for targets producing a single output, since the point is to end
    up with one uniquely named artifact per platform:

    ```python
    shims.cross_binary(
        name = "mytool-arm64-windows",
        actual = ":mytool",
        cpu = "arm64",
        os = "windows",
    )
    ```
    """,
)
