# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:shims.bzl", "shims")

shims.constraint(
    name = "build-mode",
    default = "debug",
    values = [
        "debug",
        "release",
    ],
)

# Mode files are arguments Buck2 reads from the command line (`-m local`).
shims.lint_files(
    name = "modes",
    srcs = [
        "cached",
        "cached-upload",
        "local",
        "remote",
        "sandbox",
        "sandbox-symlink",
    ],
)
