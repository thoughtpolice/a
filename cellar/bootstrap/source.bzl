# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@cellar//bootstrap/platforms:rules.bzl", "native_attrs")

def __write_file(ctx: AnalysisContext) -> list[Provider]:
    output = ctx.actions.declare_output(ctx.label.name, has_content_based_path = False)
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

    output = ctx.actions.declare_output(ctx.label.name, has_content_based_path = False)
    ctx.actions.download_file(
        output,
        ctx.attrs.urls[0],
        sha256 = hash,
        size_bytes = ctx.attrs.size_bytes,
    )

    return [
        DefaultInfo(default_output = output),
    ]

download_file = rule(impl = __download_file, attrs = {
    "urls": attrs.list(attrs.string()),
    "hash": attrs.option(attrs.string(), default = None),
    # Content-addressed downloads need a size even when the server omits
    # Content-Length (for example GitHub's archive endpoint).
    "size_bytes": attrs.option(attrs.int(), default = None),
})

def __ungz(ctx: AnalysisContext) -> list[Provider]:
    output = ctx.actions.declare_output(ctx.label.name, has_content_based_path = False)
    ctx.actions.run(
        [
            ctx.attrs.ungz[DefaultInfo].default_outputs[0],
            "--file",
            ctx.attrs.input[DefaultInfo].default_outputs[0],
            "--output",
            output.as_output(),
        ],
        category = "mes_stage0_ungz",
        clear_environment = True,
    )
    return [DefaultInfo(default_output = output)]

_ungz_rule = rule(impl = __ungz, attrs = {
    "ungz": attrs.exec_dep(),
    "input": attrs.dep(),
})

def ungz(**kwargs):
    _ungz_rule(**native_attrs(kwargs))

def __untar(ctx: AnalysisContext) -> list[Provider]:
    # The tar contains a top-level directory (e.g. mes-0.27/) so we extract
    # into a parent directory and project the actual output from it.
    # chdirenv creates the directory if it doesn't exist, then cds into it.
    parent = ctx.actions.declare_output("_untar_work", dir = True, has_content_based_path = False)
    output = parent.project(ctx.label.name)
    chdirenv = ctx.attrs.chdirenv[RunInfo]
    untar_tool = ctx.attrs.untar[RunInfo]
    input_tar = ctx.attrs.input[DefaultInfo].default_outputs[0]

    # With a decompressor, the extractor reads the archive from its standard
    # output, so no uncompressed copy of the archive is stored.
    archive = cmd_args(input_tar, relative_to = parent)
    if ctx.attrs.decompress != None:
        archive = cmd_args("--", cmd_args(ctx.attrs.decompress[RunInfo], relative_to = parent), "--file", archive)

    # Member prefixes are relative to the archive's top-level directory.
    filters = []
    for path in ctx.attrs.only:
        filters += ["--only", ctx.label.name + "/" + path]
    for path in ctx.attrs.skip:
        filters += ["--skip", ctx.label.name + "/" + path]

    ctx.actions.run(
        [
            chdirenv,
            parent.as_output(),
            cmd_args(untar_tool, relative_to = parent),
            filters,
            ctx.attrs.flags,
            archive,
        ],
        category = "mes_stage0_untar",
        clear_environment = True,
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

_untar_rule = rule(impl = __untar, attrs = {
    "chdirenv": attrs.exec_dep(providers = [RunInfo]),
    "untar": attrs.exec_dep(providers = [RunInfo]),
    "input": attrs.dep(),
    "flags": attrs.list(attrs.string(), default = ["--non-strict", "--file"]),
    "files": attrs.list(attrs.string(), default = []),
    "decompress": attrs.option(attrs.exec_dep(providers = [RunInfo]), default = None),
    "only": attrs.list(attrs.string(), default = []),
    "skip": attrs.list(attrs.string(), default = []),
})

def untar(**kwargs):
    _untar_rule(**native_attrs(kwargs))

def _project_files_impl(ctx: AnalysisContext) -> list[Provider]:
    tree = ctx.attrs.tree[DefaultInfo].default_outputs[0]
    return [DefaultInfo(
        default_output = tree,
        sub_targets = {
            path: [DefaultInfo(default_output = tree.project(path))]
            for path in ctx.attrs.files
        },
    )]

# Name paths inside another target's directory, such as a source tree that
# several packages build from, without extracting or copying it again.
_project_files_rule = rule(impl = _project_files_impl, attrs = {
    "tree": attrs.dep(),
    "files": attrs.list(attrs.string(), default = []),
})

def project_files(**kwargs):
    _project_files_rule(**native_attrs(kwargs))

def _replace_impl(ctx):
    output = ctx.actions.declare_output(ctx.label.name, has_content_based_path = False)
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

_replace_rule = rule(impl = _replace_impl, attrs = {
    "src": attrs.source(),
    "before": attrs.string(),
    "after": attrs.string(),
    "tool": attrs.exec_dep(providers = [RunInfo]),
})

def replace(**kwargs):
    _replace_rule(**native_attrs(kwargs))

def _patch_block(text, prefix):
    if not text:
        return ("0,0", "")
    lines = text.split("\n")
    if text.endswith("\n"):
        lines = lines[:-1]
    body = "".join([prefix + line + "\n" for line in lines])
    if not text.endswith("\n"):
        body += "\\ No newline at end of file\n"
    return ("1," + str(len(lines)), body)

def _exact_patch_impl(ctx):
    patch = ctx.attrs.patch
    if patch == None:
        if ctx.attrs.before == None or ctx.attrs.after == None:
            fail("exact_patch requires a patch file or both before and after strings")
        if not ctx.attrs.before:
            fail("exact_patch requires a nonempty before string")
        old_range, old_body = _patch_block(ctx.attrs.before, "-")
        new_range, new_body = _patch_block(ctx.attrs.after, "+")
        patch = ctx.actions.write(
            "replacement.patch",
            "--- before\n+++ after\n@@ -" + old_range + " +" + new_range + " @@\n" + old_body + new_body,
            has_content_based_path = False,
        )
    elif ctx.attrs.before != None or ctx.attrs.after != None:
        fail("exact_patch cannot combine a patch file with before/after strings")
    output = ctx.actions.declare_output(ctx.attrs.output, has_content_based_path = False)
    ctx.actions.run(
        cmd_args(ctx.attrs.tool[RunInfo], ctx.attrs.src, patch, output.as_output()),
        category = "source_exact_patch",
        clear_environment = True,
    )
    return [DefaultInfo(default_output = output)]

# One unified hunk describes a byte-exact replacement, including partial lines.
# The M2-built helper requires exactly one match and never modifies its input.
_exact_patch_rule = rule(impl = _exact_patch_impl, attrs = {
    "src": attrs.source(),
    "patch": attrs.option(attrs.source(), default = None),
    "before": attrs.option(attrs.string(), default = None),
    "after": attrs.option(attrs.string(), default = None),
    "output": attrs.string(default = "out"),
    "tool": attrs.exec_dep(providers = [RunInfo], default = "cellar//bootstrap/stage1/simple-patch:simple-patch"),
})

def exact_patch(**kwargs):
    _exact_patch_rule(**native_attrs(kwargs))
