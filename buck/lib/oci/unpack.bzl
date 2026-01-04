# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load(":toolchain.bzl", "OciToolchainInfo")

def _oci_unpack_impl(ctx: AnalysisContext) -> list[Provider]:
    """
    Unpack an OCI image to a filesystem bundle using umoci.
    Returns a directory containing the unpacked filesystem.
    """
    output = ctx.actions.declare_output(ctx.label.name, dir = True)

    # Get umoci from toolchain
    umoci = ctx.attrs._oci_toolchain[OciToolchainInfo].umoci[RunInfo]

    # Get image
    image = ctx.attrs.image[DefaultInfo].default_outputs[0]

    # Build command
    cmd = cmd_args(
        [
            ctx.attrs._unpack_helper[RunInfo],
            "--umoci",
            umoci,
            "--image",
            image,
            "--tag",
            ctx.attrs.tag,
            "--output",
            output.as_output(),
        ],
        hidden = image,
    )

    ctx.actions.run(
        cmd,
        category = "oci_unpack",
        identifier = ctx.label.name,
    )

    return [DefaultInfo(default_output = output)]

oci_unpack = rule(
    impl = _oci_unpack_impl,
    attrs = {
        "image": attrs.dep(
            doc = "OCI image to unpack",
            providers = [DefaultInfo],
        ),
        "tag": attrs.string(
            default = "latest",
            doc = "Tag to unpack",
        ),
        "_unpack_helper": attrs.default_only(
            attrs.exec_dep(default = "//buck/lib/oci/helpers:oci_unpack"),
        ),
        "_oci_toolchain": attrs.toolchain_dep(
            default = "toolchains//:oci",
            providers = [OciToolchainInfo],
        ),
    },
    doc = "Unpack an OCI image to a filesystem bundle",
)
