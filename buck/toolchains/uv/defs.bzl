# SPDX-FileCopyrightText: © 2024-2025 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

"""
Custom build rules for Python tools that use uv for dependency management.
"""

def _uv_python_binary_impl(ctx: AnalysisContext) -> list[Provider]:
    """Implementation for uv-based Python binaries."""
    # The main Python script
    script = ctx.attrs.main
    # Create a wrapper script that ensures uv is available and runs the Python script
    wrapper = ctx.actions.declare_output("{}.wrapper".format(ctx.label.name))
    wrapper_content = [
        "#!/bin/bash",
        "set -euo pipefail",
        "",
        "# Ensure we're in the right directory",
        "SCRIPT_DIR=\"$(cd \"$(dirname \"${{BASH_SOURCE[0]}}\")\" && pwd)\"",
        "",
        "# Execute the Python script with uv",
        "exec \"$SCRIPT_DIR/{}\" \"$@\"".format(script.short_path),
    ]

    ctx.actions.write(wrapper, "\n".join(wrapper_content), is_executable = True)
    # Collect all source files
    srcs = [script] + ctx.attrs.srcs

    # Create output directory with all files
    outdir = ctx.actions.declare_output(ctx.label.name, dir = True)
    outdir = ctx.actions.copied_dir(
        outdir,
        {
            src.short_path: src for src in srcs
        }
    )

    # Create lint sub-target
    lint_dir = ctx.attrs.lint_dir
    lint_commands = []

    # Add ruff check command
    check_args = ["uvx", "ruff", "check", lint_dir]
    lint_commands.append(check_args)

    # Add ruff format command (in check mode)
    format_args = ["uvx", "ruff", "format", "--check", lint_dir]
    lint_commands.append(format_args)

    # Create a wrapper script that runs all lint commands
    lint_wrapper = ctx.actions.declare_output("{}-lint-wrapper.sh".format(ctx.label.name))
    lint_wrapper_content = [
        "#!/bin/bash",
        "set -euo pipefail",
        "",
        "# Run all lint commands",
        "FAILED=0",
    ]

    for _, cmd in enumerate(lint_commands):
        lint_wrapper_content.extend([
            "",
            "echo 'Running: {}'".format(" ".join(cmd)),
            " ".join(cmd) + " || FAILED=1",
        ])

    lint_wrapper_content.extend([
        "",
        "if [ $FAILED -eq 1 ]; then",
        "    echo 'Lint checks failed!'",
        "    exit 1",
        "fi",
        "",
        "echo 'All checks passed!'",
    ])

    ctx.actions.write(lint_wrapper, "\n".join(lint_wrapper_content), is_executable = True)

    # Build the run arguments - prepend any default args
    run_args = cmd_args()
    run_args.add(outdir.project(script.short_path))
    if ctx.attrs.args:
        run_args.add(ctx.attrs.args)

    return [
        DefaultInfo(
            default_output = outdir,
            sub_targets = {
                "wrapper": [DefaultInfo(default_output = wrapper)],
                "script": [DefaultInfo(default_output = outdir.project(script.short_path))],
                "lint": [
                    DefaultInfo(),
                    ExternalRunnerTestInfo(
                        type = "custom",
                        command = [lint_wrapper],
                    ),
                ],
            }
        ),
        RunInfo(args = run_args),
    ]

_uv_python_binary = rule(
    impl = _uv_python_binary_impl,
    attrs = {
        "main": attrs.source(doc = "The main Python script file"),
        "srcs": attrs.list(attrs.source(), default = [], doc = "Additional source files"),
        "lint_dir": attrs.string(doc = "Directory to lint"),
        "args": attrs.list(attrs.arg(), default = [], doc = "Default arguments to prepend to the command"),
    }
)

def _uv_python_test_impl(ctx: AnalysisContext) -> list[Provider]:
    """Implementation for uv-based Python test runner."""
    # The test script
    script = ctx.attrs.script

    # Collect all arguments
    test_args = ctx.attrs.args if ctx.attrs.args else []

    return [
        DefaultInfo(),
        RunInfo(args = cmd_args([script] + test_args)),
        ExternalRunnerTestInfo(
            type = "custom",
            command = [script] + test_args,
        )
    ]

_uv_python_test = rule(
    impl = _uv_python_test_impl,
    attrs = {
        "script": attrs.source(doc = "The test script to run"),
        "args": attrs.list(attrs.string(), default = [], doc = "Arguments to pass to the test script"),
    }
)

# Macro wrappers that automatically add lint tests
def uv_python_binary(**kwargs):
    """
    Wrapper for uv.python_binary that automatically adds lint test to tests parameter.
    """
    name = kwargs.get("name")
    tests = kwargs.pop("tests", [])
    # Automatically add lint test if not already present
    lint_test = ":{}[lint]".format(name)
    if lint_test not in tests:
        tests = tests + [lint_test]

    _uv_python_binary(
        tests = tests,
        **kwargs
    )

def _uv_tool_format_impl(ctx: AnalysisContext) -> list[Provider]:
    """Implementation for uv-based formatting."""
    format_dir = ctx.attrs.format_dir
    format_args = ["uvx", "ruff", "format", format_dir]

    return [
        DefaultInfo(),
        RunInfo(args = cmd_args(format_args)),
    ]

_uv_tool_format = rule(
    impl = _uv_tool_format_impl,
    attrs = {
        "format_dir": attrs.string(doc = "Directory to format"),
    }
)

# Public API
uv = struct(
    python_binary = uv_python_binary,
    python_test = _uv_python_test,
    tool_format = _uv_tool_format,
)
