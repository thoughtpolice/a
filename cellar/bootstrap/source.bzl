# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

def __write_file(ctx: AnalysisContext) -> list[Provider]:
    output = ctx.actions.declare_output(ctx.label.name)
    ctx.actions.write(output, ctx.attrs.content)
    return [DefaultInfo(default_output = output)]

write_file = rule(impl = __write_file, attrs = {
    "content": attrs.string(),
})

def __download_file(ctx: AnalysisContext) -> list[Provider]:
    if len(ctx.attrs.urls) != 1:
        fail("expected exactly one URL to download")

    hash = ctx.attrs.hash
    if hash == None or hash == "":
        hash = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        warning("expected a hash for the tarball, this will always fail")

    output = ctx.actions.declare_output(ctx.label.name)
    ctx.actions.download_file(
        output,
        ctx.attrs.urls[0],
        sha256 = hash,
    )

    return [
        DefaultInfo(default_output = output),
    ]

download_file = rule(impl = __download_file, attrs = {
    "urls": attrs.list(attrs.string()),
    "hash": attrs.option(attrs.string(), default = None),
})

def __ungz(ctx: AnalysisContext) -> list[Provider]:
    output = ctx.actions.declare_output(ctx.label.name)
    ctx.actions.run(
        [
            ctx.attrs.ungz[DefaultInfo].default_outputs[0],
            "--file",
            ctx.attrs.input[DefaultInfo].default_outputs[0],
            "--output",
            output.as_output(),
        ],
        category = "mes_stage0_ungz",
    )
    return [DefaultInfo(default_output = output)]

ungz = rule(impl = __ungz, attrs = {
    "ungz": attrs.dep(),
    "input": attrs.dep(),
})

def __untar(ctx: AnalysisContext) -> list[Provider]:
    # The tar contains a top-level directory (e.g. mes-0.27/) so we extract
    # into a parent directory and project the actual output from it.
    # chdirenv creates the directory if it doesn't exist, then cds into it.
    parent = ctx.actions.declare_output("_untar_work", dir = True)
    output = parent.project(ctx.label.name)
    chdirenv = ctx.attrs.chdirenv[DefaultInfo].default_outputs[0]
    untar_tool = ctx.attrs.untar[DefaultInfo].default_outputs[0]
    input_tar = ctx.attrs.input[DefaultInfo].default_outputs[0]

    ctx.actions.run(
        [
            chdirenv,
            parent.as_output(),
            cmd_args(untar_tool, relative_to = parent),
            "--non-strict",
            "--file",
            cmd_args(input_tar, relative_to = parent),
        ],
        category = "mes_stage0_untar",
    )
    return [
        DefaultInfo(
            default_output = output,
            sub_targets = {
                path: [DefaultInfo(default_output = output.project(path))]
                for path in ctx.attrs.files
            },
        ),
    ]

untar = rule(impl = __untar, attrs = {
    "chdirenv": attrs.dep(),
    "untar": attrs.dep(),
    "input": attrs.dep(),
    "files": attrs.list(attrs.string(), default = []),
})

def _replace_impl(ctx):
    output = ctx.actions.declare_output(ctx.label.name)
    ctx.actions.run(
        cmd_args(
            ctx.attrs.tool[RunInfo],
            "--file",
            ctx.attrs.src,
            "--output",
            output.as_output(),
            "--match-on",
            ctx.attrs.before,
            "--replace-with",
            ctx.attrs.after,
        ),
        category = "source_replace",
        clear_environment = True,
    )
    return [DefaultInfo(default_output = output)]

replace = rule(impl = _replace_impl, attrs = {
    "src": attrs.source(),
    "before": attrs.string(),
    "after": attrs.string(),
    "tool": attrs.dep(providers = [RunInfo]),
})
