# SPDX-FileCopyrightText: © 2024-2025 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

"""
Golang toolchain definitions for Buck2.
"""

GolangToolchainInfo = provider(
    doc = "Information about the Golang toolchain",
    fields = {
        "go": provider_field(typing.Any, default = None),
        "go_os": provider_field(str),
        "go_arch": provider_field(str),
        "cgo_enabled": provider_field(bool, default = True),
    },
)

def _system_golang_toolchain_impl(_ctx):
    """Implementation of system_golang_toolchain rule."""

    # Use system Go installation
    go_cmd = RunInfo(args = ["go"])

    # Detect platform - simplified for now
    go_os = "linux"  # TODO: detect actual OS
    go_arch = "amd64"  # TODO: detect actual arch

    return [
        DefaultInfo(),
        GolangToolchainInfo(
            go = go_cmd,
            go_os = go_os,
            go_arch = go_arch,
            cgo_enabled = True,
        ),
    ]

system_golang_toolchain = rule(
    impl = _system_golang_toolchain_impl,
    attrs = {},
    is_toolchain_rule = True,
)

def _golang_binary_impl(ctx):
    """Implementation of golang_binary rule."""
    output = ctx.actions.declare_output(ctx.attrs.name)

    # Build the Go binary using system go command
    cmd = cmd_args([
        "go",
        "build",
        "-o", output.as_output(),
    ])

    # Add source files
    if ctx.attrs.srcs:
        cmd.add(ctx.attrs.srcs)
    elif ctx.attrs.main:
        cmd.add(ctx.attrs.main)
    else:
        # Default to main.go in current directory
        cmd.add(".")

    # Set environment variables for reproducible builds
    env = {
        "CGO_ENABLED": "0",  # Disable CGO for simplicity
        "GOOS": "linux",
        "GOARCH": "amd64",
    }

    ctx.actions.run(
        cmd,
        env = env,
        category = "golang_compile",
        identifier = ctx.attrs.name,
    )

    return [
        DefaultInfo(
            default_output = output,
        ),
        RunInfo(args = [output]),
    ]

go_binary = rule(
    impl = _golang_binary_impl,
    attrs = {
        "srcs": attrs.list(attrs.source(), default = []),
        "main": attrs.option(attrs.source(), default = None),
    },
)

def _golang_library_impl(_ctx):
    """Implementation of golang_library rule."""
    # For now, libraries are handled implicitly by Go modules
    # This is a placeholder for future implementation
    return [DefaultInfo()]

go_library = rule(
    impl = _golang_library_impl,
    attrs = {
        "srcs": attrs.list(attrs.source(), default = []),
    },
)
