# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@cellar//bootstrap/platforms:defs.bzl", "amd64_dep", "constraint_value", "platform")

# Both configurations must coexist in one graph; modifiers on an aggregate
# cannot replace the fixed seed dependency's incoming architecture.
amd64_dep(
    name = "seed-from-arm64",
    actual = "cellar//bootstrap/stage0-posix/seeds/linux-amd64:hex2-0",
    modifiers = ["cellar//bootstrap/platforms:arm64"],
)

# Platforms incompatible with the fixed x86 seed, used by the regression.
constraint_value(
    name = "macos",
    setting = "cellar//bootstrap/platforms:os",
)

constraint_value(
    name = "windows",
    setting = "cellar//bootstrap/platforms:os",
)

platform(
    name = "linux-aarch64",
    constraint_values = [
        "cellar//bootstrap/platforms:linux",
        "cellar//bootstrap/platforms:arm64",
    ],
)

platform(
    name = "macos-x86_64",
    constraint_values = [
        ":macos",
        "cellar//bootstrap/platforms:amd64",
    ],
)

platform(
    name = "windows-x86_64",
    constraint_values = [
        ":windows",
        "cellar//bootstrap/platforms:amd64",
    ],
)
