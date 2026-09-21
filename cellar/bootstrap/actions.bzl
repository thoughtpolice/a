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
        command = cmd_args(ctx.attrs.capture[RunInfo], output.as_output(), command)
    elif ctx.attrs.chdir != None:
        if not ctx.attrs.directory:
            fail("a generator working directory must be a directory output")
        command = cmd_args(
            ctx.attrs.chdir[RunInfo],
            output.as_output(),
            cmd_args(command, relative_to = output),
        )
        env = {key: cmd_args(value, relative_to = output) for key, value in env.items()}
    else:
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
