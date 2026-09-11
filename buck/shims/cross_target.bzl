# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

"""Build another target for a specific target triple, regardless of the
configuration the caller is being built in.

This is the triple-only sibling of cross_binary.bzl: it overlays just the
toolchains//cfg/target:target constraint onto the incoming configuration and
leaves cpu and os alone, the same shape buck/platforms uses for the uefi and
wasm32 platforms. That is the right tool for triples that do not correspond
to a host-like cpu/os pair, such as wasm32-unknown-unknown: moving config//os
to `none` would strand every select in the toolchains that keys on the host
os, while the rust and cxx toolchains already key what actually differs, the
linker and the target flags, on the triple.
"""

load("@prelude//:paths.bzl", "paths")

# Every triple the target constraint can take. The transition needs a static
# ref per value, so extending toolchains//cfg/target:target means extending
# this list too, and the load-time check below says so.
TRIPLES = [
    "x86_64-unknown-uefi",
    "x86_64-unknown-linux-gnu",
    "x86_64-apple-darwin",
    "x86_64-pc-windows-msvc",
    "aarch64-unknown-uefi",
    "aarch64-unknown-linux-gnu",
    "aarch64-apple-darwin",
    "aarch64-pc-windows-msvc",
    "wasm32-unknown-unknown",
]

def _triple_ref(triple: str) -> str:
    return "triple_" + triple.replace("-", "_")

_REFS = {
    _triple_ref(triple): "toolchains//cfg/target:target[{}]".format(triple)
    for triple in TRIPLES
}

def _cross_target_transition_impl(platform: PlatformInfo, refs: struct, attrs: struct) -> PlatformInfo:
    if attrs.triple not in TRIPLES:
        fail("cross_target_binary has no constraint for triple {}".format(attrs.triple))
    constraints = dict(platform.configuration.constraints)
    value = getattr(refs, _triple_ref(attrs.triple))[ConstraintValueInfo]
    constraints[value.setting.label] = value
    return PlatformInfo(
        label = "cfg:" + attrs.triple,
        configuration = ConfigurationInfo(
            constraints = constraints,
            values = platform.configuration.values,
        ),
    )

_cross_target_transition = transition(
    impl = _cross_target_transition_impl,
    refs = _REFS,
    attrs = ["triple"],
)

def _cross_target_binary_impl(ctx: AnalysisContext) -> list[Provider]:
    outputs = ctx.attrs.actual[DefaultInfo].default_outputs
    if len(outputs) != 1:
        fail("{actual} must produce exactly one output, got {n}".format(
            actual = ctx.attrs.actual.label.raw_target(),
            n = len(outputs),
        ))

    # The copy keeps the output's extension unless the name already ends in
    # it, so a `game.wasm` target republishing `game_core.wasm` is not
    # `game.wasm.wasm`.
    _, ext = paths.split_extension(outputs[0].short_path)
    name = ctx.label.name
    output = ctx.actions.copy_file(name if name.endswith(ext) else name + ext, outputs[0])
    return [
        DefaultInfo(default_output = output),
        RunInfo(args = cmd_args(output)),
    ]

cross_target_binary = rule(
    impl = _cross_target_binary_impl,
    cfg = _cross_target_transition,
    attrs = {
        "actual": attrs.dep(doc = "Target to rebuild for `triple`."),
        "triple": attrs.string(doc = "A value of toolchains//cfg/target:target."),
    },
    doc = """Rebuild `actual` for a target triple and republish its single
    output under this target's name.

    ```python
    shims.cross_target_binary(
        name = "game-wasm",
        actual = ":game",
        triple = "wasm32-unknown-unknown",
    )
    ```
    """,
)
