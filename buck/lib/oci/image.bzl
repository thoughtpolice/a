# SPDX-FileCopyrightText: © 2025 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load(":toolchain.bzl", "OciToolchainInfo")

def _oci_image_impl(ctx: AnalysisContext) -> list[Provider]:
    """
    Build an OCI image from a base image + layers + configuration.
    Uses pure Python OCI manipulation - no external tools required.
    """
    output = ctx.actions.declare_output(ctx.label.name, dir = True)

    # Get base image
    base_image = ctx.attrs.base[DefaultInfo].default_outputs[0]

    # Get layer tar files
    layer_files = []
    for layer_dep in ctx.attrs.layers:
        layer_outputs = layer_dep[DefaultInfo].default_outputs
        layer_files.extend(layer_outputs)

    # Build command with hidden dependencies
    cmd = cmd_args(
        [
            ctx.attrs._image_helper[RunInfo],
            "--base",
            base_image,
            "--output",
            output.as_output(),
        ],
        hidden = [base_image] + layer_files,
    )

    # Add layers if any
    if layer_files:
        cmd.add("--layers")
        cmd.add(layer_files)

    # Add environment variables
    for key, value in ctx.attrs.env.items():
        cmd.add(["--env", "{}={}".format(key, value)])

    # Add image labels
    for key, value in ctx.attrs.image_labels.items():
        cmd.add(["--label", "{}={}".format(key, value)])

    # Add entrypoint
    if ctx.attrs.entrypoint:
        cmd.add("--entrypoint={}".format(",".join(ctx.attrs.entrypoint)))

    # Add cmd
    if ctx.attrs.cmd:
        cmd.add("--cmd={}".format(",".join(ctx.attrs.cmd)))

    # Add working directory
    if ctx.attrs.working_dir:
        cmd.add(["--workdir", ctx.attrs.working_dir])

    # Add user
    if ctx.attrs.user:
        cmd.add(["--user", ctx.attrs.user])

    # Add exposed ports
    for port in ctx.attrs.exposed_ports:
        cmd.add(["--exposed-port", port])

    # Add volumes
    for volume in ctx.attrs.volumes:
        cmd.add(["--volume", volume])

    ctx.actions.run(
        cmd,
        category = "oci_image",
        identifier = ctx.label.name,
    )

    return [DefaultInfo(default_output = output)]

oci_image = rule(
    impl = _oci_image_impl,
    attrs = {
        "base": attrs.dep(
            doc = "Base OCI image (from oci_pull or another oci_image)",
            providers = [DefaultInfo],
        ),
        "layers": attrs.list(
            attrs.dep(providers = [DefaultInfo]),
            default = [],
            doc = "List of tar files to add as layers",
        ),
        "env": attrs.dict(
            key = attrs.string(),
            value = attrs.string(),
            default = {},
            doc = "Environment variables to set",
        ),
        "image_labels": attrs.dict(
            key = attrs.string(),
            value = attrs.string(),
            default = {},
            doc = "OCI image labels (metadata)",
        ),
        "entrypoint": attrs.option(
            attrs.list(attrs.string()),
            default = None,
            doc = "Entrypoint command",
        ),
        "cmd": attrs.option(
            attrs.list(attrs.string()),
            default = None,
            doc = "Default command arguments",
        ),
        "working_dir": attrs.option(
            attrs.string(),
            default = None,
            doc = "Working directory",
        ),
        "user": attrs.option(
            attrs.string(),
            default = None,
            doc = "User to run as",
        ),
        "exposed_ports": attrs.list(
            attrs.string(),
            default = [],
            doc = "Exposed ports (e.g., '8080/tcp', '53/udp')",
        ),
        "volumes": attrs.list(
            attrs.string(),
            default = [],
            doc = "Volume mount points",
        ),
        "_image_helper": attrs.default_only(
            attrs.exec_dep(default = "//buck/lib/oci/helpers:oci_image"),
        ),
        "_oci_toolchain": attrs.toolchain_dep(
            default = "toolchains//:oci",
            providers = [OciToolchainInfo],
        ),
    },
    doc = "Build an OCI container image",
)
