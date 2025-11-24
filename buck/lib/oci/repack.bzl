# SPDX-FileCopyrightText: © 2025 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load(":toolchain.bzl", "OciToolchainInfo")

def _oci_repack_impl(ctx: AnalysisContext) -> list[Provider]:
    """
    Repack a modified filesystem bundle back into an OCI image using umoci.
    Returns an OCI image layout directory.
    """
    output = ctx.actions.declare_output(ctx.label.name, dir = True)

    # Get umoci from toolchain
    umoci = ctx.attrs._oci_toolchain[OciToolchainInfo].umoci[RunInfo]

    # Get bundle
    bundle = ctx.attrs.bundle[DefaultInfo].default_outputs[0]

    # Determine hidden dependencies
    hidden_deps = [bundle]
    if ctx.attrs.base:
        base = ctx.attrs.base[DefaultInfo].default_outputs[0]
        hidden_deps.append(base)

    # Build command
    cmd = cmd_args(
        [
            ctx.attrs._repack_helper[RunInfo],
            "--umoci",
            umoci,
            "--bundle",
            bundle,
            "--output",
            output.as_output(),
            "--tag",
            ctx.attrs.tag,
        ],
        hidden = hidden_deps,
    )

    if ctx.attrs.base:
        cmd.add(["--base", base])

    ctx.actions.run(
        cmd,
        category = "oci_repack",
        identifier = ctx.label.name,
    )

    return [DefaultInfo(default_output = output)]

oci_repack = rule(
    impl = _oci_repack_impl,
    attrs = {
        "bundle": attrs.dep(
            doc = "Bundle directory to repack (from oci_unpack)",
            providers = [DefaultInfo],
        ),
        "base": attrs.option(
            attrs.dep(providers = [DefaultInfo]),
            default = None,
            doc = "Optional base image",
        ),
        "tag": attrs.string(
            default = "latest",
            doc = "Tag for the output image",
        ),
        "_repack_helper": attrs.default_only(
            attrs.exec_dep(default = "//buck/lib/oci/helpers:oci_repack"),
        ),
        "_oci_toolchain": attrs.toolchain_dep(
            default = "toolchains//:oci",
            providers = [OciToolchainInfo],
        ),
    },
    doc = "Repack a filesystem bundle into an OCI image",
)
