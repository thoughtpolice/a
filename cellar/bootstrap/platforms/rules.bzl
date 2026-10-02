# SPDX-FileCopyrightText: 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

NATIVE_CONSTRAINTS = [
    "cellar//bootstrap/platforms:linux",
    "cellar//bootstrap/platforms:amd64",
]

def native_attrs(kwargs):
    """Require the bootstrap's native ABI for both outputs and action tools."""
    result = dict(kwargs)
    cpu = result.pop("target_cpu", None)
    if cpu != None:
        # A cross target constrains what it produces. Its exec deps (including
        # those inside toolchain_dep) independently choose where actions run.
        constraints = ["cellar//bootstrap/platforms:linux", "cellar//bootstrap/platforms:" + cpu]
        result.setdefault("modifiers", constraints)
        result["target_compatible_with"] = constraints + result.get("target_compatible_with", [])
        return result
    result.setdefault("default_target_platform", "cellar//bootstrap/platforms:default")
    for key in ["target_compatible_with", "exec_compatible_with"]:
        result[key] = NATIVE_CONSTRAINTS + result.get(key, [])
    return result
