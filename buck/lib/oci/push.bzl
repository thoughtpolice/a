# SPDX-FileCopyrightText: © 2024-2025 Benjamin Brittain
# SPDX-License-Identifier: Apache-2.0

load(":toolchain.bzl", "OciToolchainInfo")

def _oci_push_impl(ctx: AnalysisContext) -> list[Provider]:
    image = ctx.attrs.image
    output = ctx.actions.declare_output("{}.tar".format(ctx.attrs.name))
    platform = ctx.attrs.platforms[0]

    cmd = cmd_args(
        ctx.attrs._push[RunInfo],
        "--crane",
        ctx.attrs._oci_toolchain[OciToolchainInfo].crane[RunInfo],
        "--platform",
        platform,
        "--output",
        output.as_output(),
        "--image",
        image,
        "--digest",
        ctx.attrs.digest,
    )

    ctx.actions.run(cmd, category = "oci")

    return [DefaultInfo(default_output = output)]

oci_push = rule(
    impl = _oci_push_impl,
    attrs = {
        "digest": attrs.string(),
        "image": attrs.string(),
        "platforms": attrs.list(attrs.string()),
        "_push": attrs.default_only(attrs.exec_dep(default = "//buck/lib/oci/helpers:push")),
        "_oci_toolchain": attrs.toolchain_dep(
            default = "toolchains//:oci",
            providers = [OciToolchainInfo],
        ),
    },
)
