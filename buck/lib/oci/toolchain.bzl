# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@prelude//:rules.bzl", "http_file")
load(":versions.json", versions_data = "value")

# Extract release data from JSON
skopeo_releases = versions_data["skopeo"]["releases"]
umoci_releases = versions_data["umoci"]["releases"]

def _host_arch() -> str:
    arch = host_info().arch
    if arch.is_x86_64:
        return "x86_64"
    elif arch.is_aarch64:
        return "arm64"
    else:
        fail("Unsupported host architecture: {}".format(arch))

def _host_os() -> str:
    os = host_info().os
    if os.is_linux:
        return "Linux"
    elif os.is_macos:
        return "Darwin"
    else:
        fail("Unsupported host OS: {}".format(os))

def _get_platform_key(os: str, arch: str) -> str:
    return "{}-{}".format(os, arch)

def _get_release(releases: dict, version: str, platform: str):
    if version not in releases:
        fail("Unsupported version: {}".format(version))
    if platform not in releases[version]:
        fail("Unsupported platform {} for version {}".format(platform, version))
    return releases[version][platform]

# Binary wrapper rules
def _skopeo_binary_impl(ctx: AnalysisContext) -> list[Provider]:
    """Makes skopeo binary executable and provides RunInfo"""
    output = ctx.actions.declare_output("skopeo")
    src = ctx.attrs.bin[DefaultInfo].default_outputs[0]

    # Copy and make executable
    ctx.actions.run(
        ["cp", src, output.as_output()],
        category = "cp_skopeo",
    )

    skopeo_cmd = cmd_args(output, hidden = src)

    return [
        DefaultInfo(default_output = output),
        RunInfo(args = skopeo_cmd),
    ]

skopeo_binary = rule(
    impl = _skopeo_binary_impl,
    attrs = {
        "bin": attrs.dep(providers = [DefaultInfo]),
    },
)

def _umoci_binary_impl(ctx: AnalysisContext) -> list[Provider]:
    """Makes umoci binary executable and provides RunInfo"""
    output = ctx.actions.declare_output("umoci")
    src = ctx.attrs.bin[DefaultInfo].default_outputs[0]

    # Copy and make executable
    ctx.actions.run(
        ["cp", src, output.as_output()],
        category = "cp_umoci",
    )

    umoci_cmd = cmd_args(output, hidden = src)

    return [
        DefaultInfo(default_output = output),
        RunInfo(args = umoci_cmd),
    ]

umoci_binary = rule(
    impl = _umoci_binary_impl,
    attrs = {
        "bin": attrs.dep(providers = [DefaultInfo]),
    },
)

def _patchelf_binary_impl(ctx: AnalysisContext) -> list[Provider]:
    """Makes the patchelf binary executable and provides RunInfo"""
    output = ctx.actions.declare_output("patchelf")
    src = ctx.attrs.bin[DefaultInfo].default_outputs[0]

    ctx.actions.run(
        ["cp", src, output.as_output()],
        category = "cp_patchelf",
    )

    patchelf_cmd = cmd_args(output, hidden = src)

    return [
        DefaultInfo(default_output = output),
        RunInfo(args = patchelf_cmd),
    ]

patchelf_binary = rule(
    impl = _patchelf_binary_impl,
    attrs = {
        "bin": attrs.dep(providers = [DefaultInfo]),
    },
)

# Download helpers
def download_skopeo(
        name: str,
        version: [None, str] = None,
        arch: [None, str] = None,
        os: [None, str] = None):
    """Download skopeo binary for the current platform"""
    if version == None:
        version = versions_data["skopeo"]["default_version"]
    if arch == None:
        arch = _host_arch()
    if os == None:
        os = _host_os()

    platform = _get_platform_key(os, arch)
    release = _get_release(skopeo_releases, version, platform)

    http_file(
        name = "{}_download".format(name),
        urls = [release["url"]],
        sha256 = release["sha256"],
        executable = True,
    )

    skopeo_binary(
        name = name,
        bin = ":{}_download".format(name),
    )

def download_umoci(
        name: str,
        version: [None, str] = None,
        arch: [None, str] = None,
        os: [None, str] = None):
    """Download umoci binary for the current platform"""
    if version == None:
        version = versions_data["umoci"]["default_version"]
    if arch == None:
        arch = _host_arch()
    if os == None:
        os = _host_os()

    platform = _get_platform_key(os, arch)
    release = _get_release(umoci_releases, version, platform)

    http_file(
        name = "{}_download".format(name),
        urls = [release["url"]],
        sha256 = release["sha256"],
        executable = True,
    )

    umoci_binary(
        name = name,
        bin = ":{}_download".format(name),
    )

# Toolchain provider
OciToolchainInfo = provider(
    doc = "OCI toolchain providing skopeo, umoci, and patchelf",
    fields = {
        "patchelf": provider_field(typing.Any, default = None),
        "skopeo": provider_field(typing.Any, default = None),
        "umoci": provider_field(typing.Any, default = None),
    },
)

def _oci_toolchain_impl(ctx) -> list[[DefaultInfo, OciToolchainInfo]]:
    """OCI toolchain implementation"""
    return [
        DefaultInfo(),
        OciToolchainInfo(
            patchelf = ctx.attrs.patchelf,
            skopeo = ctx.attrs.skopeo,
            umoci = ctx.attrs.umoci,
        ),
    ]

oci_toolchain = rule(
    impl = _oci_toolchain_impl,
    attrs = {
        "patchelf": attrs.exec_dep(providers = [RunInfo]),
        "skopeo": attrs.exec_dep(providers = [RunInfo]),
        "umoci": attrs.exec_dep(providers = [RunInfo]),
    },
    is_toolchain_rule = True,
)
