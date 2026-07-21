# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/lib/oci:toolchain.bzl", "oci_toolchain", "patchelf_binary", "skopeo_binary", "umoci_binary")
load("@root//buck/shims:shims.bzl", "shims")

shims.http_file(
    name = "skopeo_x86_64",
    executable = True,
    sha256 = "067d461564e606b4f54f30453a9f21a53aabc4f1bb0acd5193ffff5b1aececbc",
    target_compatible_with = ["config//os:linux"],
    urls = ["https://github.com/lework/skopeo-binary/releases/download/v1.24.1/skopeo-linux-amd64"],
)

shims.http_file(
    name = "skopeo_arm64",
    executable = True,
    sha256 = "a7e32a8f39110a55e0230e0f27bf50f1b2e4f36841793b07a7ba711877e63020",
    target_compatible_with = ["config//os:linux"],
    urls = ["https://github.com/lework/skopeo-binary/releases/download/v1.24.1/skopeo-linux-arm64"],
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
    sha256 = "a6818fef80128fb354423234ecacdcca3e993913d774e5d8346bc63f70fed4cf",
    sub_targets = ["bin/patchelf"],
    type = "tar.gz",
    urls = ["https://github.com/NixOS/patchelf/releases/download/0.19.1/patchelf-0.19.1-x86_64.tar.gz"],
)

shims.http_archive(
    name = "patchelf_arm64",
    sha256 = "a2f8f5add5910a521d35062adf2c9f55d75b65ae5508d290758787004054e702",
    sub_targets = ["bin/patchelf"],
    type = "tar.gz",
    urls = ["https://github.com/NixOS/patchelf/releases/download/0.19.1/patchelf-0.19.1-aarch64.tar.gz"],
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
