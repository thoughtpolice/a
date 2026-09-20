# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:shims.bzl", "shims")

shims.config_setting(
    name = "linux-x86_64",
    constraint_values = [
        "prelude//cpu/constraints:x86_64",
        "prelude//os/constraints:linux",
    ],
    visibility = ["PUBLIC"],
)

shims.config_setting(
    name = "macos-x86_64",
    constraint_values = [
        "prelude//cpu/constraints:x86_64",
        "prelude//os/constraints:macos",
    ],
    visibility = ["PUBLIC"],
)

shims.config_setting(
    name = "windows-x86_64",
    constraint_values = [
        "prelude//cpu/constraints:x86_64",
        "prelude//os/constraints:windows",
    ],
    visibility = ["PUBLIC"],
)
