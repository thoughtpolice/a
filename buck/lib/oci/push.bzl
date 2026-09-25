# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

"""Push an OCI image layout to a registry with `buck2 run`."""

load(":toolchain.bzl", "OciToolchainInfo")

def _oci_push_impl(ctx: AnalysisContext) -> list[Provider]:
    image = ctx.attrs.image[DefaultInfo].default_outputs[0]
    command = cmd_args([
        ctx.attrs._push_helper[RunInfo],
        "--skopeo",
        ctx.attrs._oci_toolchain[OciToolchainInfo].skopeo[RunInfo],
        "--image",
        image,
    ])
    if ctx.attrs.repository:
        command.add("--repository", ctx.attrs.repository)
    for tag in ctx.attrs.tags:
        command.add("--default-tag", tag)

    # Pushing talks to the network and changes a registry, so it happens
    # when the target runs, never as a cached build action. Building the
    # target builds the image.
    return [
        DefaultInfo(other_outputs = [image]),
        RunInfo(args = command),
    ]

oci_push = rule(
    impl = _oci_push_impl,
    attrs = {
        "image": attrs.dep(
            providers = [DefaultInfo],
            doc = "OCI image layout or multi-platform index to push",
        ),
        "repository": attrs.option(
            attrs.string(),
            default = None,
            doc = "Registry repository that --tag and `tags` push to, such as ghcr.io/me/app",
        ),
        "tags": attrs.list(
            attrs.string(),
            default = [],
            doc = "Tags pushed to `repository` when `buck2 run` names no destination",
        ),
        "_push_helper": attrs.default_only(
            attrs.exec_dep(default = "//buck/lib/oci/helpers:oci_push"),
        ),
        "_oci_toolchain": attrs.toolchain_dep(
            default = "toolchains//:oci",
            providers = [OciToolchainInfo],
        ),
    },
    doc = "Push an OCI layout with skopeo when run: buck2 run :target -- REF...",
)
