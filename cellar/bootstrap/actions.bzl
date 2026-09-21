# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

# Native bootstrap tools deliberately use attrs.dep: cellar target constraints
# differ from the repository execution platform's constraints.

def _generate_impl(ctx):
    output = ctx.actions.declare_output(ctx.attrs.output, dir = ctx.attrs.directory)
    command = cmd_args(ctx.attrs.tool[RunInfo], ctx.attrs.args, hidden = ctx.attrs.inputs)
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

generate = rule(impl = _generate_impl, attrs = {
    "tool": attrs.dep(providers = [RunInfo]),
    "args": attrs.list(attrs.arg(), default = []),
    "env": attrs.dict(attrs.string(), attrs.arg(), default = {}),
    "inputs": attrs.list(attrs.source(), default = []),
    "output": attrs.string(default = "out"),
    "output_flags": attrs.list(attrs.string(), default = []),
    "directory": attrs.bool(default = False),
    "files": attrs.list(attrs.string(), default = []),
    "chdir": attrs.option(attrs.dep(providers = [RunInfo]), default = None),
    "capture": attrs.option(attrs.dep(providers = [RunInfo]), default = None),
    "stdin": attrs.option(attrs.source(), default = None),
    "working_directory": attrs.option(attrs.source(), default = None),
})

def _concatenate_impl(ctx):
    output = ctx.actions.declare_output(ctx.attrs.output)
    ctx.actions.run(
        cmd_args(ctx.attrs.tool[RunInfo], output.as_output(), ctx.attrs.inputs),
        clear_environment = True,
        category = "bootstrap_concatenate",
    )
    return [DefaultInfo(default_output = output)]

# catm accepts the output first, followed by an ordered list of inputs.
concatenate = rule(impl = _concatenate_impl, attrs = {
    "tool": attrs.dep(providers = [RunInfo]),
    "inputs": attrs.list(attrs.source()),
    "output": attrs.string(default = "out"),
})

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
configured_tool = rule(impl = _configured_tool_impl, attrs = {
    "tool": attrs.dep(providers = [RunInfo]),
    "args": attrs.list(attrs.arg(), default = []),
    "env": attrs.dict(attrs.string(), attrs.arg(), default = {}),
    "env_tool": attrs.option(attrs.dep(providers = [RunInfo]), default = None),
})

def _command_test_impl(ctx):
    command = cmd_args(ctx.attrs.tool[RunInfo], ctx.attrs.args, hidden = ctx.attrs.inputs)
    return [DefaultInfo(), ExternalRunnerTestInfo(
        type = "simple",
        command = [command],
        env = ctx.attrs.env,
        run_from_project_root = True,
        use_project_relative_paths = True,
    )]

command_test = rule(impl = _command_test_impl, attrs = {
    "tool": attrs.dep(providers = [RunInfo]),
    "args": attrs.list(attrs.arg(), default = []),
    "env": attrs.dict(attrs.string(), attrs.arg(), default = {}),
    "inputs": attrs.list(attrs.source(), default = []),
})
