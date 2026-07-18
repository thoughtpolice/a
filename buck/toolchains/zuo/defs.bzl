# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

"""Zuo language toolchain and build rules.

This module provides the Zuo toolchain and associated build rules for creating
Zuo binaries, modules, and tests.
"""

# Provider that contains the Zuo toolchain information
ZuoToolchain = provider(
    doc = "Zuo toolchain provider",
    fields = {
        "zuo": provider_field(typing.Any),
        "stdlib": provider_field(typing.Any, default = None),
    },
)

def _zuo_toolchain_impl(ctx: AnalysisContext) -> list[Provider]:
    """Implementation of the zuo_toolchain rule."""
    return [
        DefaultInfo(),
        ZuoToolchain(
            zuo = ctx.attrs.zuo[RunInfo],
            stdlib = ctx.attrs.stdlib,
        ),
    ]

zuo_toolchain = rule(
    impl = _zuo_toolchain_impl,
    attrs = {
        "zuo": attrs.exec_dep(),
        "stdlib": attrs.source(),
    },
    is_toolchain_rule = True,
)

def _zuo_binary_impl(ctx: AnalysisContext) -> list[Provider]:
    """Implementation of the zuo_binary rule."""
    toolchain = ctx.attrs._zuo_toolchain[ZuoToolchain]

    # For now, just run the Zuo script directly
    # In a real implementation, we'd create a proper wrapper
    return [
        DefaultInfo(),
        RunInfo(args = cmd_args(toolchain.zuo.args).add(ctx.attrs.main)),
    ]

def _zuo_module_impl(ctx: AnalysisContext) -> list[Provider]:
    """Implementation of the zuo_module rule."""

    # For now, modules are just filegroups that can be depended on
    return [
        DefaultInfo(default_outputs = ctx.attrs.srcs),
    ]

def _zuo_embedded_binary_impl(ctx: AnalysisContext) -> list[Provider]:
    """Implementation of the zuo_embedded_binary rule."""
    toolchain = ctx.attrs._zuo_toolchain[ZuoToolchain]

    # Generate image_zuo.c with embedded modules
    image_c = ctx.actions.declare_output(ctx.label.name + "_image.c")

    # Build command to generate the embedded image
    cmd = cmd_args()
    cmd.add("cd", "$SRCDIR")
    cmd.add("&&")

    # Copy necessary files to working directory
    cmd.add("cp", "-r", ctx.attrs._stdlib, "lib")
    cmd.add("&&")
    cmd.add("cp", ctx.attrs._image_zuo, "image.zuo")
    cmd.add("&&")
    cmd.add("cp", ctx.attrs._zuo_c, "zuo.c")
    cmd.add("&&")

    # Run the image generator
    cmd.add(toolchain.zuo)
    cmd.add("image.zuo")
    cmd.add("-o", image_c.as_output())
    cmd.add("--keep-collects")

    # Add embedded modules
    for mod in ctx.attrs.embed_modules:
        cmd.add("++lib", mod)

    ctx.actions.run(
        cmd_args("sh", "-c", cmd),
        category = "zuo_embed",
        env = {"SRCDIR": cmd_args(ctx.actions.symlinked_dir("srcs", {
            "lib": ctx.attrs._stdlib,
            "image.zuo": ctx.attrs._image_zuo,
            "zuo.c": ctx.attrs._zuo_c,
        }))},
    )

    # Now compile the generated C file
    # This is a bit hacky - we're invoking the C++ toolchain directly
    # In a real implementation, we'd use the cxx rules properly
    output = ctx.actions.declare_output(ctx.label.name)

    cxx_cmd = cmd_args()
    cxx_cmd.add("cc")
    cxx_cmd.add("-O2")
    cxx_cmd.add("-o", output.as_output())
    cxx_cmd.add(image_c)

    ctx.actions.run(
        cxx_cmd,
        category = "cxx_link",
    )

    return [
        DefaultInfo(default_output = output),
        RunInfo(args = cmd_args(output)),
    ]

def _zuo_test_impl(ctx: AnalysisContext) -> list[Provider]:
    """Implementation of the zuo_test rule."""
    toolchain = ctx.attrs._zuo_toolchain[ZuoToolchain]

    # For tests, we run the zuo script directly
    test_cmd = cmd_args()
    test_cmd.add(toolchain.zuo)
    test_cmd.add(ctx.attrs.src)

    return [
        DefaultInfo(),
        ExternalRunnerTestInfo(
            type = "zuo",
            command = [test_cmd],
        ),
    ]

# Private rule implementations
_zuo_binary = rule(
    impl = _zuo_binary_impl,
    attrs = {
        "main": attrs.source(),
        "deps": attrs.list(attrs.dep(), default = []),
        "_zuo_toolchain": attrs.toolchain_dep(
            default = "toolchains//:zuo",
            providers = [ZuoToolchain],
        ),
    },
)

_zuo_module = rule(
    impl = _zuo_module_impl,
    attrs = {
        "srcs": attrs.list(attrs.source()),
        "deps": attrs.list(attrs.dep(), default = []),
    },
)

_zuo_embedded_binary = rule(
    impl = _zuo_embedded_binary_impl,
    attrs = {
        "main": attrs.source(),
        "embed_modules": attrs.list(attrs.string(), default = ["zuo"]),
        "deps": attrs.list(attrs.dep(), default = []),
        "_zuo_toolchain": attrs.toolchain_dep(
            default = "toolchains//:zuo",
            providers = [ZuoToolchain],
        ),
        "_stdlib": attrs.source(default = "third-party//by-name/zu/zuo:stdlib"),
        "_image_zuo": attrs.source(default = "third-party//by-name/zu/zuo:local/image.zuo"),
        "_zuo_c": attrs.source(default = "third-party//by-name/zu/zuo:zuo.c"),
    },
)

_zuo_test = rule(
    impl = _zuo_test_impl,
    attrs = {
        "src": attrs.source(),
        "deps": attrs.list(attrs.dep(), default = []),
        "_zuo_toolchain": attrs.toolchain_dep(
            default = "toolchains//:zuo",
            providers = [ZuoToolchain],
        ),
    },
)

# Public API - these are the macros that users will call
def zuo_binary(
        name: str,
        main: str,
        deps: list[str] = [],
        **kwargs):
    """Create a Zuo binary target.

    Args:
        name: Target name
        main: Main .zuo source file
        deps: Module dependencies
        **kwargs: Additional arguments passed to the rule
    """
    _zuo_binary(
        name = name,
        main = main,
        deps = deps,
        **kwargs
    )

def zuo_module(
        name: str,
        srcs: list[str],
        deps: list[str] = [],
        **kwargs):
    """Create a Zuo module target.

    Args:
        name: Target name
        srcs: Zuo source files
        deps: Module dependencies
        **kwargs: Additional arguments passed to the rule
    """
    _zuo_module(
        name = name,
        srcs = srcs,
        deps = deps,
        **kwargs
    )

def zuo_embedded_binary(
        name: str,
        main: str,
        embed_modules: list[str] = ["zuo"],
        deps: list[str] = [],
        **kwargs):
    """Create a Zuo binary with embedded modules.

    Args:
        name: Target name
        main: Main .zuo source file
        embed_modules: Modules to embed (default: ["zuo"])
        deps: Module dependencies
        **kwargs: Additional arguments passed to the rule
    """
    _zuo_embedded_binary(
        name = name,
        main = main,
        embed_modules = embed_modules,
        deps = deps,
        **kwargs
    )

def zuo_test(
        name: str,
        src: str,
        deps: list[str] = [],
        **kwargs):
    """Create a Zuo test target.

    Args:
        name: Target name
        src: Test .zuo source file
        deps: Module dependencies
        **kwargs: Additional arguments passed to the rule
    """
    _zuo_test(
        name = name,
        src = src,
        deps = deps,
        **kwargs
    )

# Export the public API
zuo = struct(
    binary = zuo_binary,
    module = zuo_module,
    embedded_binary = zuo_embedded_binary,
    test = zuo_test,
)
