# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

# Executed tools are configured for the cellar-owned Linux/x86_64 executor.

load("@cellar//bootstrap:host.bzl", "host_test_executor")
load("@cellar//bootstrap/platforms:rules.bzl", "native_attrs")

def _generate_impl(ctx):
    output = ctx.actions.declare_output(ctx.attrs.output, dir = ctx.attrs.directory, has_content_based_path = False)

    # Visit complete input trees before projected arguments. The native
    # sandbox otherwise creates partial parent directories for child paths.
    command = cmd_args(cmd_args(hidden = ctx.attrs.inputs), ctx.attrs.tool[RunInfo], ctx.attrs.args)
    if ctx.attrs.source_tree != None:
        if ctx.attrs.chdir == None or ctx.attrs.source_alias == None:
            fail("logical generator sources require chdir and source_alias")
        command = cmd_args(ctx.attrs.source_alias[RunInfo], ctx.attrs.source_tree, command)
    elif ctx.attrs.source_alias != None:
        fail("source_alias requires source_tree")
    env = ctx.attrs.env
    if ctx.attrs.capture != None:
        if ctx.attrs.directory or ctx.attrs.chdir != None or ctx.attrs.output_flags:
            fail("stdout capture requires a file output without output flags or chdir")
        capture = cmd_args(ctx.attrs.capture[RunInfo])
        if ctx.attrs.stdin != None:
            capture.add("--stdin", ctx.attrs.stdin)
        if ctx.attrs.working_directory != None:
            capture.add("--cwd", ctx.attrs.working_directory)
            command = cmd_args(command, relative_to = ctx.attrs.working_directory)
            env = {key: cmd_args(value, relative_to = ctx.attrs.working_directory) for key, value in env.items()}
        command = cmd_args(capture, output.as_output(), command)
    elif ctx.attrs.chdir != None:
        if ctx.attrs.stdin != None or ctx.attrs.working_directory != None:
            fail("stdin and working_directory require capture")
        if not ctx.attrs.directory:
            fail("a generator working directory must be a directory output")
        command = cmd_args(
            ctx.attrs.chdir[RunInfo],
            output.as_output(),
            cmd_args(command, relative_to = output),
        )
        env = {key: cmd_args(value, relative_to = output) for key, value in env.items()}
    else:
        if ctx.attrs.stdin != None or ctx.attrs.working_directory != None:
            fail("stdin and working_directory require capture")
        command.add(ctx.attrs.output_flags, output.as_output())
    ctx.actions.run(command, env = env, clear_environment = True, category = "bootstrap_generate")
    return [DefaultInfo(
        default_output = output,
        sub_targets = {path: [DefaultInfo(default_output = output.project(path))] for path in ctx.attrs.files},
    )]

_generate_rule = rule(impl = _generate_impl, attrs = {
    "tool": attrs.exec_dep(providers = [RunInfo]),
    "source_tree": attrs.option(attrs.source(), default = None),
    "source_alias": attrs.option(attrs.exec_dep(providers = [RunInfo]), default = None),
    "args": attrs.list(attrs.arg(), default = []),
    "env": attrs.dict(attrs.string(), attrs.arg(), default = {}),
    "inputs": attrs.list(attrs.source(), default = []),
    "output": attrs.string(default = "out"),
    "output_flags": attrs.list(attrs.string(), default = []),
    "directory": attrs.bool(default = False),
    "files": attrs.list(attrs.string(), default = []),
    "chdir": attrs.option(attrs.exec_dep(providers = [RunInfo]), default = None),
    "capture": attrs.option(attrs.exec_dep(providers = [RunInfo]), default = None),
    "stdin": attrs.option(attrs.source(), default = None),
    "working_directory": attrs.option(attrs.source(), default = None),
})

def generate(**kwargs):
    _generate_rule(**native_attrs(kwargs))

def _concatenate_impl(ctx):
    output = ctx.actions.declare_output(ctx.attrs.output, has_content_based_path = False)
    ctx.actions.run(
        cmd_args(ctx.attrs.tool[RunInfo], output.as_output(), ctx.attrs.inputs),
        clear_environment = True,
        category = "bootstrap_concatenate",
    )
    return [DefaultInfo(default_output = output)]

# catm accepts the output first, followed by an ordered list of inputs.
_concatenate_rule = rule(impl = _concatenate_impl, attrs = {
    "tool": attrs.exec_dep(providers = [RunInfo]),
    "inputs": attrs.list(attrs.source()),
    "output": attrs.string(default = "out"),
})

def concatenate(**kwargs):
    _concatenate_rule(**native_attrs(kwargs))

def _configured_tool_impl(ctx):
    command = cmd_args(ctx.attrs.tool[RunInfo], ctx.attrs.args)
    if ctx.attrs.env:
        if ctx.attrs.env_tool == None:
            fail("configured tool environments require an explicit environment helper")
        assignments = [cmd_args(key + "=", value, delimiter = "") for key, value in ctx.attrs.env.items()]
        command = cmd_args(ctx.attrs.env_tool[RunInfo], assignments, "--", command)
    return [DefaultInfo(default_outputs = ctx.attrs.tool[DefaultInfo].default_outputs), RunInfo(args = command)]

# Preserve artifact dependencies in both arguments and environment values.
# Consumers must use RunInfo; DefaultInfo refers to the underlying executable.
_configured_tool_rule = rule(impl = _configured_tool_impl, attrs = {
    "tool": attrs.exec_dep(providers = [RunInfo]),
    "args": attrs.list(attrs.arg(), default = []),
    "env": attrs.dict(attrs.string(), attrs.arg(), default = {}),
    "env_tool": attrs.option(attrs.exec_dep(providers = [RunInfo]), default = None),
})

def configured_tool(**kwargs):
    _configured_tool_rule(**native_attrs(kwargs))

def _command_test_impl(ctx):
    command = cmd_args(cmd_args(hidden = ctx.attrs.inputs), ctx.attrs.tool[RunInfo], ctx.attrs.args)
    return [DefaultInfo(), ExternalRunnerTestInfo(
        type = "simple",
        command = [command],
        env = ctx.attrs.env,
        labels = ctx.attrs.labels,
        default_executor = host_test_executor(ctx.attrs.host_executor) if ctx.attrs.host_executor else None,
        run_from_project_root = True,
        use_project_relative_paths = True,
    )]

_command_test_rule = rule(impl = _command_test_impl, attrs = {
    "tool": attrs.exec_dep(providers = [RunInfo]),
    "args": attrs.list(attrs.arg(), default = []),
    "env": attrs.dict(attrs.string(), attrs.arg(), default = {}),
    "inputs": attrs.list(attrs.source(), default = []),
    "labels": attrs.list(attrs.string(), default = []),
    "host_executor": attrs.option(attrs.dep(), default = None),
})

# `host_paths` runs the test where the host's system paths stay readable, for
# checks that bootstrap programs ignore the host tools next to them.
def command_test(host_paths = False, **kwargs):
    if host_paths:
        kwargs["host_executor"] = "cellar//bootstrap/platforms:host-tests"
    _command_test_rule(**native_attrs(kwargs))

def _installed_tool_impl(ctx):
    path = ctx.attrs.path
    if not path or path.startswith("/") or ".." in path.split("/"):
        fail("installed executable must have a relative path within its installation")
    executable = ctx.attrs.installation.project(path)

    # Keep the complete installation visible before the executable projection
    # creates its parent directories in the native sandbox.
    command = cmd_args(cmd_args(hidden = ctx.attrs.installation), executable)
    return [DefaultInfo(default_output = executable), RunInfo(args = command)]

# A runnable projection retains the complete installation as an input: the
# executable can locate its declared runtime, headers and helpers at runtime.
_installed_tool_rule = rule(impl = _installed_tool_impl, attrs = {
    "installation": attrs.source(),
    "path": attrs.string(),
})

def installed_tool(**kwargs):
    _installed_tool_rule(**native_attrs(kwargs))
