# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

"""Buck2 rules for filecheck-driven tests.

Two rules are provided, both reached through `shims.filecheck`:

  - `filecheck_test` runs one tool and checks its output against one check
    file: `filecheck exec CHECK -- TOOL ARGS...`. It is a single opaque test.

  - `filecheck_lit` runs lit-style test files whose `RUN:` lines drive the
    tools under test. Under Buck2's internal test runner every file is a
    listed case and every RUN line reports its own result, via the same line
    protocol as `shims.dynamic_test` (see dynamic_test_internal.bzl). The
    fallback runs all files as one opaque test.

Tools under test are ordinary target-configuration deps, so a `-m release`
build tests the release tool. The filecheck binary itself is an exec dep.
Tool locations reach the runner through a JSON manifest written with
`with_inputs`, which also carries the tools' artifacts as inputs of the test.
"""

load("@root//buck/shims:dynamic_test_internal.bzl", "dynamic_runner_test_info")

_FILECHECK = "root//buck/tools/filecheck:filecheck"

# write_json renders artifacts relative to the project. Keep their identity
# in each argument so lit.go can make just those paths absolute at execution.
_PROJECT_ROOT_MARKER = "__FILECHECK_PROJECT_ROOT__/"

_COMMON_ATTRS = {
    "contacts": attrs.list(attrs.string(), default = []),
    "env": attrs.dict(attrs.string(), attrs.arg(), default = {}),
    "labels": attrs.list(attrs.string(), default = []),
    "_filecheck": attrs.default_only(attrs.exec_dep(default = _FILECHECK, providers = [RunInfo])),
}

def _filecheck_test_impl(ctx: AnalysisContext) -> list[Provider]:
    cmd = cmd_args(ctx.attrs._filecheck[RunInfo], "exec")
    cmd.add("--capture", ctx.attrs.capture)
    if ctx.attrs.input != None:
        cmd.add("--stdin", ctx.attrs.input)
    if ctx.attrs.any_exit:
        cmd.add("--any-exit")
    else:
        cmd.add("--expect-exit", str(ctx.attrs.expect_exit))
    for prefix in ctx.attrs.check_prefixes:
        cmd.add("--check-prefix", prefix)
    for name, value in ctx.attrs.defines.items():
        cmd.add(cmd_args("-D", name, "=", value, delimiter = ""))
    cmd.add(ctx.attrs.flags)
    cmd.add(ctx.attrs.check)
    cmd.add("--")
    cmd.add(ctx.attrs.dep[RunInfo].args)
    cmd.add(ctx.attrs.args)
    cmd.add(cmd_args(hidden = ctx.attrs.data))
    return [
        DefaultInfo(),
        RunInfo(args = cmd),
        ExternalRunnerTestInfo(
            type = "filecheck",
            command = [cmd],
            env = ctx.attrs.env,
            labels = ctx.attrs.labels,
            contacts = ctx.attrs.contacts,
            run_from_project_root = True,
            use_project_relative_paths = True,
        ),
    ]

filecheck_test = rule(
    impl = _filecheck_test_impl,
    attrs = _COMMON_ATTRS | {
        "any_exit": attrs.bool(default = False, doc = "Accept any exit status from the tool."),
        "args": attrs.list(attrs.arg(), default = [], doc = "Arguments passed to the tool."),
        "capture": attrs.enum(["stdout", "stderr", "both"], default = "stdout", doc = "Which output of the tool is checked."),
        "check": attrs.source(doc = "The check file."),
        "check_prefixes": attrs.list(attrs.string(), default = [], doc = "Directive prefixes; CHECK when empty."),
        "data": attrs.list(attrs.source(allow_directory = True), default = [], doc = "Files the tool reads at runtime."),
        "defines": attrs.dict(attrs.string(), attrs.arg(), default = {}, doc = "-D string variables for the check file."),
        "dep": attrs.dep(providers = [RunInfo], doc = "The tool under test."),
        "expect_exit": attrs.int(default = 0, doc = "Exit status the tool must return."),
        "flags": attrs.list(attrs.arg(), default = [], doc = "Extra filecheck options, e.g. --match-full-lines."),
        "input": attrs.option(attrs.source(), default = None, doc = "File fed to the tool's standard input."),
    },
    doc = "Run a tool and check its output with a FileCheck-style check file.",
)

def _filecheck_lit_impl(ctx: AnalysisContext, internal: bool) -> list[Provider]:
    # Test names are protocol tokens; the runner refers to files by index.
    for src in ctx.attrs.srcs:
        if " " in src.short_path or "\t" in src.short_path:
            fail("filecheck_lit: test path '{}' contains whitespace; the runner protocol cannot carry it".format(src.short_path))

    manifest_file = ctx.actions.declare_output("manifest.json")
    manifest = ctx.actions.write_json(
        manifest_file,
        {
            "defines": {name: cmd_args(value, delimiter = "", absolute_prefix = _PROJECT_ROOT_MARKER) for name, value in ctx.attrs.defines.items()},
            "features": ctx.attrs.features,
            "package": ctx.label.package,
            "tools": {name: cmd_args(dep[RunInfo].args, absolute_prefix = _PROJECT_ROOT_MARKER) for name, dep in ctx.attrs.tools.items()},
        },
        with_inputs = True,
        pretty = True,
    )
    common = cmd_args("lit", "--manifest", manifest, ctx.attrs.srcs, hidden = ctx.attrs.data)
    filecheck = ctx.attrs._filecheck[RunInfo]
    batch = cmd_args(filecheck, common)

    providers = [
        DefaultInfo(sub_targets = {"manifest": [DefaultInfo(default_output = manifest_file)]}),
        RunInfo(args = batch),
    ]
    if internal:
        providers.append(dynamic_runner_test_info(
            ctx,
            test_type = "filecheck-lit",
            command = [cmd_args(filecheck, "-run-test", common)],
            listing_command = [cmd_args(filecheck, "-list-tests", common)],
            run_from_project_root = True,
            use_project_relative_paths = True,
        ))
    else:
        providers.append(ExternalRunnerTestInfo(
            type = "filecheck-lit",
            command = [batch],
            env = ctx.attrs.env,
            labels = ctx.attrs.labels,
            contacts = ctx.attrs.contacts,
            run_from_project_root = True,
            use_project_relative_paths = True,
        ))
    return providers

_LIT_ATTRS = _COMMON_ATTRS | {
    "data": attrs.list(attrs.source(allow_directory = True), default = [], doc = "Files RUN lines may read, e.g. via %S."),
    "defines": attrs.dict(attrs.string(), attrs.arg(), default = {}, doc = "%{name} substitutions; $(location) paths in them stay valid after a RUN line changes directory."),
    "features": attrs.list(attrs.string(), default = [], doc = "Features for REQUIRES:/UNSUPPORTED:/XFAIL:."),
    "srcs": attrs.list(attrs.source(), doc = "Test files containing RUN: lines."),
    "tools": attrs.dict(attrs.string(), attrs.dep(providers = [RunInfo]), default = {}, doc = "Tools under test; %name and %{name} expand to each."),
}

filecheck_lit_internal = rule(
    impl = lambda ctx: _filecheck_lit_impl(ctx, True),
    attrs = _LIT_ATTRS,
    doc = "lit-style RUN: tests driven by Buck2's internal runner, one result per RUN line.",
)

filecheck_lit_external = rule(
    impl = lambda ctx: _filecheck_lit_impl(ctx, False),
    attrs = _LIT_ATTRS,
    doc = "Fallback that runs all lit-style test files as one opaque test.",
)
