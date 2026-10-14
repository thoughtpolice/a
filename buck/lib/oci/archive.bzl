# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

"""Export an OCI image layout as a Docker-compatible archive."""

load(":toolchain.bzl", "OciToolchainInfo")

def _oci_archive_impl(ctx: AnalysisContext) -> list[Provider]:
    image = ctx.attrs.image[DefaultInfo].default_outputs[0]
    output = ctx.actions.declare_output(ctx.attrs.out or ctx.label.name + ".tar")

    command = cmd_args([
        ctx.attrs._oci_toolchain[OciToolchainInfo].oci[RunInfo],
        "archive",
        "--image",
        image,
        "--source-tag",
        ctx.attrs.source_tag,
        "--name",
        ctx.attrs.image_name,
        "--tag",
        ctx.attrs.tag,
        "--output",
        output.as_output(),
    ])

    ctx.actions.run(
        command,
        category = "oci_archive",
        identifier = ctx.attrs.image_name,
    )
    return [DefaultInfo(default_output = output)]

oci_archive = rule(
    impl = _oci_archive_impl,
    attrs = {
        "image": attrs.dep(
            providers = [DefaultInfo],
            doc = "OCI image layout to export",
        ),
        "image_name": attrs.string(
            doc = "Repository name embedded in the Docker archive",
        ),
        "tag": attrs.string(
            default = "latest",
            doc = "Tag embedded in the Docker archive",
        ),
        "source_tag": attrs.string(
            default = "latest",
            doc = "Tag to read from the source OCI layout",
        ),
        "out": attrs.option(
            attrs.string(),
            default = None,
            doc = "Output filename (defaults to <target>.tar)",
        ),
        "_oci_toolchain": attrs.toolchain_dep(
            default = "toolchains//:oci",
            providers = [OciToolchainInfo],
        ),
    },
    doc = "Export an OCI image layout as a tar accepted by docker load",
)
