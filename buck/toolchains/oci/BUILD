# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/lib/oci:toolchain.bzl", "oci_toolchain")

# Both tools build from source in this repository, so the toolchain
# downloads nothing of its own.
oci_toolchain(
    name = "oci",
    oci = "root//buck/tools/oci:oci",
    patchelf = "third-party//by-name/pa/patchelf:patchelf",
    target_compatible_with = ["config//os:linux"],
    visibility = ["PUBLIC"],
)
