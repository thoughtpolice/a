# SPDX-FileCopyrightText: 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

"""Cellar's constraint modifiers, without a dependency on the prelude.

Precedence is platform, PACKAGE, target, CLI. For execution dependencies the
executor's platform wins: a package requesting ARM must never relabel an x86
executor. Fixed predecessors use transitions, not target modifiers.
"""

_PREFIX = "cellar//bootstrap/platforms:"
_PLATFORMS = [_PREFIX + "default", _PREFIX + "linux-arm64"]
_ALIASES = {name: _PREFIX + cpu for name, cpu in {
    "amd64": "amd64",
    "x86_64": "amd64",
    "arm64": "arm64",
    "aarch64": "arm64",
    "linux": "linux",
}.items()}

def modifier_stage0(*, legacy_platform, package_modifiers, target_modifiers, cli_modifiers, configuring_exec_dep = False, **_kwargs):
    modifiers = []
    for modifier in ([] if configuring_exec_dep else (package_modifiers or []) + (target_modifiers or []) + cli_modifiers):
        # The parent project has its own build-mode modifiers. Its PACKAGE
        # metadata is deliberately outside the standalone bootstrap config.
        if type(modifier) != "string":
            continue
        modifier = _ALIASES.get(modifier, modifier)
        if modifier.startswith(("cellar//", "depot-cellar//")):
            modifiers.append(modifier)
    return _PLATFORMS + modifiers, struct(
        legacy = legacy_platform,
        modifiers = modifiers,
        execution = configuring_exec_dep,
    )

def modifier_stage1(*, refs, params):
    base = params.legacy or refs[_PLATFORMS[0]][PlatformInfo]
    constraints = dict(base.configuration.constraints)
    for modifier in params.modifiers:
        constraints.update(refs[modifier][ConfigurationInfo].constraints)
    if params.execution:
        constraints.update(base.configuration.constraints)
    config = ConfigurationInfo(constraints = constraints, values = base.configuration.values)

    # Preserve canonical identities, including the already cached seed graph.
    for candidate in [refs[label][PlatformInfo] for label in _PLATFORMS] + [base]:
        if candidate.configuration == config:
            return candidate
    return PlatformInfo(label = "cellar-modifiers", configuration = config)

def init_modifiers():
    set_cfg_constructor(
        stage0 = modifier_stage0,
        stage1 = modifier_stage1,
        key = "buck.cfg_modifiers",
        aliases = struct(),
        extra_data = struct(),
    )
