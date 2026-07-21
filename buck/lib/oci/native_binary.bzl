# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

"""Reusable OCI layers and images for native, Nix-linked executables."""

load("@prelude//cxx:cxx_toolchain_types.bzl", "CxxToolchainInfo")
load(":archive.bzl", "oci_archive")
load(":image.bzl", "oci_image")
load(":toolchain.bzl", "OciToolchainInfo")

def _native_binary_layer_impl(ctx: AnalysisContext) -> list[Provider]:
    binary = ctx.attrs.binary
    packaged_binary = binary

    if ctx.attrs.strip != "none":
        packaged_binary = ctx.actions.declare_output(ctx.label.name + ".stripped")
        strip_tool = ctx.attrs._cxx_toolchain[CxxToolchainInfo].binary_utilities_info.strip
        strip_flags = (
            ["--strip-all"] if ctx.attrs.strip == "all" else ["--strip-debug", "--strip-unneeded"]
        )
        ctx.actions.run(
            cmd_args([
                strip_tool,
            ] + strip_flags + [
                "-o",
                packaged_binary.as_output(),
                binary,
            ]),
            category = "native_binary_strip",
            identifier = ctx.label.name,
            local_only = ctx.attrs._cxx_toolchain[CxxToolchainInfo].linker_info.link_binaries_locally,
        )

    output = ctx.actions.declare_output(ctx.label.name + ".tar.gz")
    command = cmd_args([
        ctx.attrs._layer_helper[RunInfo],
        "--binary",
        packaged_binary,
        "--output",
        output.as_output(),
        "--destination",
        ctx.attrs.destination,
        "--patchelf",
        ctx.attrs._oci_toolchain[OciToolchainInfo].patchelf[RunInfo],
        "--include-nix-store",
        "true" if ctx.attrs.include_nix_store else "false",
    ], hidden = [packaged_binary])
    if ctx.attrs.interpreter != None:
        command.add(["--interpreter", ctx.attrs.interpreter])
    if ctx.attrs.rpath != None:
        command.add(["--rpath", ctx.attrs.rpath])

    ctx.actions.run(
        command,
        category = "native_binary_layer",
        identifier = ctx.label.name,
        # Discovering immutable /nix/store roots and optional patchelf use are
        # deliberately local. The resulting tar is still a normal OCI layer.
        local_only = True,
    )
    return [DefaultInfo(default_output = output)]

native_binary_layer = rule(
    impl = _native_binary_layer_impl,
    attrs = {
        "binary": attrs.source(
            doc = "Native ELF executable to install",
        ),
        "destination": attrs.string(
            doc = "Absolute path of the executable in the image",
        ),
        "strip": attrs.enum(
            ["none", "debug", "all"],
            default = "debug",
            doc = "Symbol stripping applied before packaging",
        ),
        "include_nix_store": attrs.bool(
            default = True,
            doc = "Include Nix roots referenced by PT_INTERP and RUNPATH",
        ),
        "interpreter": attrs.option(
            attrs.string(),
            default = None,
            doc = "Replacement ELF interpreter for a compatible container base",
        ),
        "rpath": attrs.option(
            attrs.string(),
            default = None,
            doc = "Replacement ELF RUNPATH for a compatible container base",
        ),
        "_layer_helper": attrs.default_only(
            attrs.exec_dep(default = "//buck/lib/oci/helpers:native_binary_layer"),
        ),
        "_oci_toolchain": attrs.toolchain_dep(
            default = "toolchains//:oci",
            providers = [OciToolchainInfo],
        ),
        "_cxx_toolchain": attrs.toolchain_dep(
            default = "toolchains//:cxx",
            providers = [CxxToolchainInfo],
        ),
    },
    doc = "Package a native ELF and its optional Nix runtime closure as an OCI layer",
)

def oci_native_binary_image(
        name,
        binary,
        base,
        destination = None,
        layers = [],
        strip = "debug",
        include_nix_store = True,
        interpreter = None,
        rpath = None,
        docker_archive = True,
        docker_image_name = None,
        **kwargs):
    """Build an OCI application image and an optional `<name>-docker` archive.

    By default the binary keeps its original interpreter/RUNPATH and its Nix
    store roots are copied into the layer. A caller with an ABI-compatible base
    can instead set `interpreter`, `rpath`, and `include_nix_store = False` to
    use the base image's runtime libraries.
    """
    destination = destination or "/usr/local/bin/" + name
    layer_name = name + "-binary-layer"
    compatibility = {}
    if "target_compatible_with" in kwargs:
        compatibility["target_compatible_with"] = kwargs["target_compatible_with"]

    native_binary_layer(
        name = layer_name,
        binary = binary,
        destination = destination,
        include_nix_store = include_nix_store,
        interpreter = interpreter,
        rpath = rpath,
        strip = strip,
        **compatibility
    )

    if "entrypoint" not in kwargs:
        kwargs["entrypoint"] = [destination]
    oci_image(
        name = name,
        base = base,
        layers = layers + [":" + layer_name],
        **kwargs
    )

    if docker_archive:
        archive_kwargs = dict(compatibility)
        if "visibility" in kwargs:
            archive_kwargs["visibility"] = kwargs["visibility"]
        oci_archive(
            name = name + "-docker",
            image = ":" + name,
            image_name = docker_image_name or name,
            out = name + ".tar",
            **archive_kwargs
        )
