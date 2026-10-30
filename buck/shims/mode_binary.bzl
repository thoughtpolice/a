# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

"""Build another target in a given build mode, regardless of the mode the
caller is being built in.

A modifier, from a PACKAGE file, a target's `modifiers` or `-m`, only applies
to the targets named on the command line: a target reached as a dependency
takes the configuration of what depends on it. A tool that has to be fast,
such as an interpreter that tests run, would then be a debug build whenever
the tests are. An incoming-edge transition belongs to the target that
declares it and applies wherever that target is reached, as cross_binary.bzl
does for a cpu and os.

The transition overlays the build mode onto the incoming configuration and
keeps everything else, cpu, os and target triple included, and its name too,
so that it lands on the configuration a modifier choosing that mode gives:
a target reached both ways is built once.
"""

MODES = [
    "debug",
    "release",
]

_REFS = {mode: "mode//:build-mode[{}]".format(mode) for mode in MODES}

def _mode_transition_impl(platform: PlatformInfo, refs: struct, attrs: struct) -> PlatformInfo:
    constraints = dict(platform.configuration.constraints)
    value = getattr(refs, attrs.mode)[ConstraintValueInfo]
    constraints[value.setting.label] = value
    return PlatformInfo(
        label = platform.label,
        configuration = ConfigurationInfo(
            constraints = constraints,
            values = platform.configuration.values,
        ),
    )

_mode_transition = transition(
    impl = _mode_transition_impl,
    refs = _REFS,
    attrs = ["mode"],
)

def _mode_binary_impl(ctx: AnalysisContext) -> list[Provider]:
    return [ctx.attrs.actual[DefaultInfo], ctx.attrs.actual[RunInfo]]

mode_binary = rule(
    impl = _mode_binary_impl,
    cfg = _mode_transition,
    attrs = {
        "actual": attrs.dep(providers = [RunInfo], doc = "Target to build in `mode`."),
        "mode": attrs.enum(MODES),
    },
    doc = """`actual` built in `mode` wherever this target is reached from, with
    its outputs and the command that runs it:

    ```python
    shims.mode_binary(
        name = "mytool-release",
        actual = ":mytool",
        mode = "release",
    )
    ```
    """,
)
