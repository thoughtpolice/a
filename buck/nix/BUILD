# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:shims.bzl", "shims")

# Toolchains that come from the dev shell depend on these, so that a change
# to the shell reruns the actions that use it.
[
    shims.export_file(
        name = name,
        src = name,
        # By path rather than a copy, so error messages name the real file.
        mode = "reference",
        visibility = ["PUBLIC"],
    )
    for name in [
        "flake.lock",
        "lean4.nix",
    ]
]
