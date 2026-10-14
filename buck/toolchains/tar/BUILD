# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@depot//buck/lib/tar:toolchain.bzl", "tar_toolchain")
load("@root//buck/shims:shims.bzl", "shims")

# Create the tar toolchain
tar_toolchain(
    name = "tar",
    visibility = ["PUBLIC"],
)

shims.lint_package()
