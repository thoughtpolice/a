# SPDX-FileCopyrightText: © 2024-2025 Benjamin Brittain
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/lib/oci:toolchain.bzl", "oci_toolchain", "download_crane_binary")

download_crane_binary(
    name = "crane",
    version = "0.19.1",
)

oci_toolchain(
    name = "oci",
    crane = ":crane",
    visibility = ["PUBLIC"],
)
