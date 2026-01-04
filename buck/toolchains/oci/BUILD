# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:shims.bzl", "shims")
load("@root//buck/lib/oci:toolchain.bzl", "oci_toolchain", "skopeo_binary", "umoci_binary")

shims.http_file(
    name = "skopeo_x86_64",
    urls = ["https://github.com/lework/skopeo-binary/releases/download/v1.20.0/skopeo-linux-amd64"],
    sha256 = "e5d3f410839313c0b28ef4659643146dad88653fc831aa15adf705421fa06fc0",
    executable = True,
    target_compatible_with = ["config//os:linux"],
)

shims.http_file(
    name = "skopeo_arm64",
    urls = ["https://github.com/lework/skopeo-binary/releases/download/v1.20.0/skopeo-linux-arm64"],
    sha256 = "c53670037b0a861ffaae1ce11baaca511d0722e4b537ab11c19a04660d8e6021",
    executable = True,
    target_compatible_with = ["config//os:linux"],
)

skopeo_binary(
    name = "skopeo",
    bin = shims.select({
        "config//cpu:x86_64": ":skopeo_x86_64",
        "config//cpu:arm64": ":skopeo_arm64",
    }),
    target_compatible_with = ["config//os:linux"],
)

shims.http_file(
    name = "umoci_x86_64",
    urls = ["https://github.com/opencontainers/umoci/releases/download/v0.6.0/umoci.linux.amd64"],
    sha256 = "b51c267ec394499e42c6fde47f240b7b7dba57ea49df0b5acd304378b82a3b71",
    executable = True,
    target_compatible_with = ["config//os:linux"],
)

shims.http_file(
    name = "umoci_arm64",
    urls = ["https://github.com/opencontainers/umoci/releases/download/v0.6.0/umoci.linux.arm64"],
    sha256 = "5cfd17f2e7a4bcf9ed67ea1b955ca893d200349b9ce6a3d3707dba415f458a1f",
    executable = True,
    target_compatible_with = ["config//os:linux"],
)

umoci_binary(
    name = "umoci",
    bin = shims.select({
        "config//cpu:x86_64": ":umoci_x86_64",
        "config//cpu:arm64": ":umoci_arm64",
    }),
    target_compatible_with = ["config//os:linux"],
)

oci_toolchain(
    name = "oci",
    skopeo = ":skopeo",
    umoci = ":umoci",
    visibility = ["PUBLIC"],
    target_compatible_with = ["config//os:linux"],
)
