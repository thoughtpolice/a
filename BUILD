# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:shims.bzl", "shims")

# Scripts and configuration read by tools other than Buck2, so no target names
# them.
shims.lint_files(
    name = "files",
    srcs = [
        ".buckconfig",
        ".envrc.nix.recommended",
        "buck/ci.buckargs",
        "buck/ci.buckconfig",
        "check.py",
        "doctor.py",
    ] + glob([
        ".buckconfig.d/*",
        ".devcontainer/*.sh",
        ".github/**/*.yml",
        "src/repo-doctor/*.py",
    ]),
)
