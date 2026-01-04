# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load(":toolchain.bzl", "OciToolchainInfo")

def _oci_index_impl(ctx: AnalysisContext) -> list[Provider]:
    """
    Create a multi-platform OCI image index.
    Combines multiple platform-specific images into a single index.
    """
    output = ctx.actions.declare_output(ctx.label.name, dir = True)

    # Collect all image dependencies
    image_deps = []
    for image_dep in ctx.attrs.images:
        image = image_dep[DefaultInfo].default_outputs[0]
        image_deps.append(image)

    # Build command
    cmd = cmd_args(
        [
            ctx.attrs._index_helper[RunInfo],
            "--output",
            output.as_output(),
        ],
        hidden = image_deps,
    )

    # Add all images with their platforms
    for image_dep, platform in zip(ctx.attrs.images, ctx.attrs.platforms):
        image = image_dep[DefaultInfo].default_outputs[0]
        # Format: path:platform
        cmd.add(["--image", cmd_args([image, ":", platform], delimiter = "")])

    ctx.actions.run(
        cmd,
        category = "oci_index",
        identifier = ctx.label.name,
    )

    return [DefaultInfo(default_output = output)]

oci_index = rule(
    impl = _oci_index_impl,
    attrs = {
        "images": attrs.list(
            attrs.dep(providers = [DefaultInfo]),
            doc = "List of platform-specific images",
        ),
        "platforms": attrs.list(
            attrs.string(),
            doc = "Platform strings corresponding to images (e.g., ['linux/amd64', 'linux/arm64'])",
        ),
        "_index_helper": attrs.default_only(
            attrs.exec_dep(default = "//buck/lib/oci/helpers:oci_index"),
        ),
        "_oci_toolchain": attrs.toolchain_dep(
            default = "toolchains//:oci",
            providers = [OciToolchainInfo],
        ),
    },
    doc = "Create a multi-platform OCI image index",
)
