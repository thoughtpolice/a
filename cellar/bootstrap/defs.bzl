
def __export_file_impl(ctx: AnalysisContext) -> list[Provider]:
    return [
        DefaultInfo(default_output = ctx.attrs.src),
    ]

__export_file = rule(impl = __export_file_impl, attrs = {
    "src": attrs.source(),
})

def export_file(name):
    __export_file(
        name = name,
        src = name,
    )

def __filegroup_impl(ctx: AnalysisContext) -> list[Provider]:
    if type(ctx.attrs.srcs) == type({}):
        srcs = ctx.attrs.srcs
    else:
        srcs = { src.short_path: src for src in ctx.attrs.srcs }

    output = ctx.actions.copied_dir(ctx.label.name, srcs)
    return [ DefaultInfo(default_output = output) ]

filegroup = rule(
    doc = """Create a directory that contains links to a list of srcs.

    Each symlink is based on the shortpath for the given `srcs[x]`. The output
    directory uses `name` for its name.
    """,
    impl = __filegroup_impl,
    attrs = {
        "srcs": attrs.option(attrs.named_set(attrs.source(), sorted = False), default = None),
    },
)

def __stage0_answer_test(ctx: AnalysisContext) -> list[Provider]:
    bindir = ctx.attrs.input[DefaultInfo].default_outputs[0]
    exe = ctx.attrs.command[DefaultInfo].default_outputs[0]
    chdirexec = ctx.attrs.chdirexec[DefaultInfo].default_outputs[0]

    cmd = [
        cmd_args(chdirexec),
        cmd_args(bindir),
        cmd_args(exe, relative_to = bindir),
    ]

    return [
        DefaultInfo(),
        ExternalRunnerTestInfo(type = "simple", command = cmd + ctx.attrs.args),
    ]

stage0_answer_test = rule(impl = __stage0_answer_test, attrs = {
    "chdirexec": attrs.dep(),
    "command": attrs.dep(),
    "input": attrs.dep(),
    "args": attrs.list(attrs.arg()),
})
