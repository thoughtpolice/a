# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load(":defs.bzl", "zuo_toolchain")

# The default Zuo toolchain using the embedded Zuo executable
zuo_toolchain(
    name = "zuo",
    zuo = "third-party//by-name/zu/zuo:zuo",
    stdlib = "third-party//by-name/zu/zuo:stdlib",
    visibility = ["PUBLIC"],
)
