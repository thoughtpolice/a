# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:shims.bzl", "shims")
load(":defs.bzl", "zuo_toolchain")

# The default Zuo toolchain using the embedded Zuo executable
zuo_toolchain(
    name = "zuo",
    stdlib = "third-party//by-name/zu/zuo:stdlib",
    visibility = ["PUBLIC"],
    zuo = "third-party//by-name/zu/zuo:zuo",
)

shims.lint_package()
