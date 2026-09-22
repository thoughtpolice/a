# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@cellar//bootstrap/platforms:defs.bzl", "constraint_value", "platform")

# Deliberately unsupported targets used only by the configuration regression.
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
        "cellar//bootstrap/platforms:aarch64",
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
