# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

"""Docker runtime smoke tests for OCI image layouts."""

load(":toolchain.bzl", "OciToolchainInfo")

def _oci_container_test_impl(ctx: AnalysisContext) -> list[Provider]:
    image = ctx.attrs.image[DefaultInfo].default_outputs[0]
    command = cmd_args([
        ctx.attrs._smoke_helper[RunInfo],
        "--skopeo",
        ctx.attrs._oci_toolchain[OciToolchainInfo].skopeo[RunInfo],
        "--image",
        image,
        "--ready-log",
        ctx.attrs.ready_log,
        "--timeout-seconds",
        str(ctx.attrs.timeout_seconds),
    ], hidden = [image])
    if ctx.attrs.args:
        command.add("--")
        command.add(ctx.attrs.args)

    return [
        DefaultInfo(),
        RunInfo(args = command),
        ExternalRunnerTestInfo(
            type = "custom",
            command = [command],
        ),
    ]

oci_container_test = rule(
    impl = _oci_container_test_impl,
    attrs = {
        "image": attrs.dep(
            providers = [DefaultInfo],
            doc = "OCI image layout to import and run",
        ),
        "ready_log": attrs.string(
            doc = "Fixed log substring that marks the container ready",
        ),
        "timeout_seconds": attrs.int(
            default = 15,
            doc = "Maximum startup time",
        ),
        "args": attrs.list(
            attrs.arg(),
            default = [],
            doc = "Optional arguments that replace the image Cmd",
        ),
        "_smoke_helper": attrs.default_only(
            attrs.exec_dep(default = "//buck/lib/oci/helpers:container_smoke"),
        ),
        "_oci_toolchain": attrs.toolchain_dep(
            default = "toolchains//:oci",
            providers = [OciToolchainInfo],
        ),
    },
    doc = "Import an OCI layout into Docker and wait for readiness",
)
