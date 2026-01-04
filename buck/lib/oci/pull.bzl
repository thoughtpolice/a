# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load(":toolchain.bzl", "OciToolchainInfo")

def _oci_pull_impl(ctx: AnalysisContext) -> list[Provider]:
    """
    Pull an OCI image from a registry using skopeo.
    Returns an OCI image layout directory.
    """
    output = ctx.actions.declare_output(ctx.label.name, dir = True)

    # Get skopeo from toolchain
    skopeo = ctx.attrs._oci_toolchain[OciToolchainInfo].skopeo[RunInfo]

    # Build command
    cmd = cmd_args([
        ctx.attrs._pull_helper[RunInfo],
        "--skopeo",
        skopeo,
        "--image",
        ctx.attrs.image,
        "--platform",
        ctx.attrs.platform,
        "--output",
        output.as_output(),
    ])

    if ctx.attrs.digest:
        cmd.add(["--digest", ctx.attrs.digest])

    ctx.actions.run(
        cmd,
        category = "oci_pull",
        identifier = ctx.attrs.image,
    )

    return [DefaultInfo(default_output = output)]

oci_pull = rule(
    impl = _oci_pull_impl,
    attrs = {
        "image": attrs.string(
            doc = "Image reference (e.g., 'docker.io/library/alpine')",
        ),
        "digest": attrs.option(
            attrs.string(),
            default = None,
            doc = "Optional digest (e.g., 'sha256:...')",
        ),
        "platform": attrs.string(
            default = "linux/amd64",
            doc = "Platform (e.g., 'linux/amd64', 'linux/arm64')",
        ),
        "_pull_helper": attrs.default_only(
            attrs.exec_dep(default = "//buck/lib/oci/helpers:oci_pull"),
        ),
        "_oci_toolchain": attrs.toolchain_dep(
            default = "toolchains//:oci",
            providers = [OciToolchainInfo],
        ),
    },
    doc = "Pull an OCI image from a container registry",
)
