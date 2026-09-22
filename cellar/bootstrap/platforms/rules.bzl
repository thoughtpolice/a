# SPDX-FileCopyrightText: 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

NATIVE_CONSTRAINTS = [
    "cellar//bootstrap/platforms:linux",
    "cellar//bootstrap/platforms:amd64",
]

def native_attrs(kwargs):
    """Require the bootstrap's native ABI for both outputs and action tools."""
    result = dict(kwargs)
    result.setdefault("default_target_platform", "cellar//bootstrap/platforms:default")
    for key in ["target_compatible_with", "exec_compatible_with"]:
        result[key] = NATIVE_CONSTRAINTS + result.get(key, [])
    return result
