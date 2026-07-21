# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/lib/oci:toolchain.bzl", "oci_toolchain", "patchelf_binary", "skopeo_binary", "umoci_binary")
load("@root//buck/shims:shims.bzl", "shims")

shims.http_file(
    name = "skopeo_x86_64",
    executable = True,
    sha256 = "e5d3f410839313c0b28ef4659643146dad88653fc831aa15adf705421fa06fc0",
    target_compatible_with = ["config//os:linux"],
    urls = ["https://github.com/lework/skopeo-binary/releases/download/v1.20.0/skopeo-linux-amd64"],
)

shims.http_file(
    name = "skopeo_arm64",
    executable = True,
    sha256 = "c53670037b0a861ffaae1ce11baaca511d0722e4b537ab11c19a04660d8e6021",
    target_compatible_with = ["config//os:linux"],
    urls = ["https://github.com/lework/skopeo-binary/releases/download/v1.20.0/skopeo-linux-arm64"],
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
    executable = True,
    sha256 = "b51c267ec394499e42c6fde47f240b7b7dba57ea49df0b5acd304378b82a3b71",
    target_compatible_with = ["config//os:linux"],
    urls = ["https://github.com/opencontainers/umoci/releases/download/v0.6.0/umoci.linux.amd64"],
)

shims.http_file(
    name = "umoci_arm64",
    executable = True,
    sha256 = "5cfd17f2e7a4bcf9ed67ea1b955ca893d200349b9ce6a3d3707dba415f458a1f",
    target_compatible_with = ["config//os:linux"],
    urls = ["https://github.com/opencontainers/umoci/releases/download/v0.6.0/umoci.linux.arm64"],
)

umoci_binary(
    name = "umoci",
    bin = shims.select({
        "config//cpu:x86_64": ":umoci_x86_64",
        "config//cpu:arm64": ":umoci_arm64",
    }),
    target_compatible_with = ["config//os:linux"],
)

# PatchELF's release binaries are statically linked, so the OCI packaging
# action does not depend on a host package or the repository's Nix shell.
shims.http_archive(
    name = "patchelf_x86_64",
    sha256 = "ce84f2447fb7a8679e58bc54a20dc2b01b37b5802e12c57eece772a6f14bf3f0",
    sub_targets = ["bin/patchelf"],
    type = "tar.gz",
    urls = ["https://github.com/NixOS/patchelf/releases/download/0.18.0/patchelf-0.18.0-x86_64.tar.gz"],
)

shims.http_archive(
    name = "patchelf_arm64",
    sha256 = "ae13e2effe077e829be759182396b931d8f85cfb9cfe9d49385516ea367ef7b2",
    sub_targets = ["bin/patchelf"],
    type = "tar.gz",
    urls = ["https://github.com/NixOS/patchelf/releases/download/0.18.0/patchelf-0.18.0-aarch64.tar.gz"],
)

patchelf_binary(
    name = "patchelf",
    bin = shims.select({
        "config//cpu:x86_64": ":patchelf_x86_64[bin/patchelf]",
        "config//cpu:arm64": ":patchelf_arm64[bin/patchelf]",
    }),
    target_compatible_with = ["config//os:linux"],
)

oci_toolchain(
    name = "oci",
    patchelf = ":patchelf",
    skopeo = ":skopeo",
    target_compatible_with = ["config//os:linux"],
    umoci = ":umoci",
    visibility = ["PUBLIC"],
)
