# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

# Every bootstrap program is a static x86_64 Linux executable, and each stage
# runs the previous stage's programs, so the rules require x86_64 Linux of both
# the target and the executor: locally on an x86_64 Linux client, and on
# remote x86_64 Linux workers from any other.
NATIVE_CONSTRAINTS = [
    "config//cpu/constraints:x86_64",
    "config//os/constraints:linux",
]

def native_attrs(kwargs):
    """Require the bootstrap's native ABI for both outputs and action tools."""
    result = dict(kwargs)
    for key in ["target_compatible_with", "exec_compatible_with"]:
        result[key] = NATIVE_CONSTRAINTS + result.get(key, [])
    return result

def __export_file_impl(ctx: AnalysisContext) -> list[Provider]:
    return [
        DefaultInfo(default_output = ctx.attrs.src),
    ]

__export_file = rule(impl = __export_file_impl, attrs = {
    "src": attrs.source(),
})

def export_file(name, **kwargs):
    __export_file(
        name = name,
        src = name,
        **kwargs
    )

def __filegroup_impl(ctx: AnalysisContext) -> list[Provider]:
    if type(ctx.attrs.srcs) == type({}):
        srcs = ctx.attrs.srcs
    else:
        srcs = {src.short_path: src for src in ctx.attrs.srcs}

    # Buck records a copied directory's contents by inserting each source in
    # turn, and a directory replaces whatever lies at its path, while the
    # copy on disk merges them. A source inside another would differ between
    # the local tree and what remote workers receive, so none may overlap.
    projections = dict(srcs)
    for path in srcs:
        parts = path.split("/")
        for end in range(1, len(parts)):
            parent = "/".join(parts[:end])
            if parent in srcs:
                fail("{} lies inside {}, which is also a source".format(path, parent))
            projections[parent] = None
    output = ctx.actions.copied_dir(ctx.label.name, srcs)
    return [DefaultInfo(default_output = output, sub_targets = {
        path: [DefaultInfo(default_output = output.project(path))]
        for path in projections
    })]

filegroup = rule(
    doc = """Copy `srcs` into one directory named `name`.

    A dict maps each path in the directory to its source. A list places each
    source at its short path. Every path is also a sub-target.
    """,
    impl = __filegroup_impl,
    attrs = {
        "srcs": attrs.named_set(attrs.source(), sorted = False, default = {}),
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

_stage0_answer_test_rule = rule(impl = __stage0_answer_test, attrs = {
    "chdirexec": attrs.dep(),
    "command": attrs.dep(),
    "input": attrs.dep(),
    "args": attrs.list(attrs.arg()),
})

def stage0_answer_test(**kwargs):
    _stage0_answer_test_rule(**native_attrs(kwargs))
