# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

"""HTTP scenario tests run by barf, with optional Buck local resources.

barf is an ordinary executable dependency, selected for the execution platform
by attrs.exec_dep. Each test runs one barf script; Buck provisions any declared
LocalResourceInfo dependencies and injects their environment only during
execution, not listing. There is no application-specific fixture logic here.
"""

load("@root//buck/shims:srclint.bzl", "srclint")

def _valid_variable_name(name: str) -> bool:
    if not name or name[0].isdigit():
        return False
    for c in name.elems():
        if not (c.isalnum() or c == "_"):
            return False
    return True

def _barf_test_impl(ctx: AnalysisContext) -> list[Provider]:
    command = cmd_args(
        ctx.attrs._barf[RunInfo].args,
        "--connect-timeout",
        ctx.attrs.connect_timeout,
        "--timeout",
        ctx.attrs.request_timeout,
    )
    for name, value in ctx.attrs.variables.items():
        if not _valid_variable_name(name):
            fail("barf.test variable names must match [A-Za-z_][A-Za-z0-9_]*, got {}".format(repr(name)))
        command.add("--var", cmd_args(name, "=", value, delimiter = ""))
    if ctx.attrs.file_root != None:
        command.add("--file-root", ctx.attrs.file_root)
    command.add(ctx.attrs.src, cmd_args(hidden = ctx.attrs.data))
    return [
        DefaultInfo(),
        RunInfo(args = command),
        ExternalRunnerTestInfo(
            type = "barf",
            command = [command],
            contacts = ctx.attrs.contacts,
            env = ctx.attrs.env,
            labels = ctx.attrs.labels,
            local_resources = {name: dep.label for name, dep in ctx.attrs.local_resources.items()},
            required_local_resources = [
                RequiredTestLocalResource(name, listing = False, execution = True)
                for name in ctx.attrs.local_resources
            ],
            run_from_project_root = True,
            use_project_relative_paths = True,
            # HTTP results depend on live state, even without a Buck resource.
            supports_test_execution_caching = False,
        ),
    ]

_barf_test = rule(
    impl = _barf_test_impl,
    attrs = {
        "connect_timeout": attrs.string(default = "5s", doc = "Connection timeout per request, as a Go duration."),
        "contacts": attrs.list(attrs.string(), default = []),
        "data": attrs.list(attrs.source(allow_directory = True), default = [], doc = "Additional runtime inputs referenced by the script."),
        "env": attrs.dict(attrs.string(), attrs.arg(), default = {}, doc = "Test environment; resource environment is added by Buck."),
        "file_root": attrs.option(attrs.source(allow_directory = True), default = None, doc = "Directory for relative body-file paths; defaults to the script's directory."),
        "labels": attrs.list(attrs.string(), default = []),
        "local_resources": attrs.dict(attrs.string(), attrs.dep(providers = [LocalResourceInfo]), default = {}, doc = "Named Buck-managed services, needed only during execution."),
        "request_timeout": attrs.string(default = "30s", doc = "Maximum duration of each request and its response, as a Go duration; not a whole-script timeout."),
        "src": attrs.source(doc = "One .barf script, reported as one Buck test."),
        "variables": attrs.dict(attrs.string(), attrs.arg(), default = {}, doc = "Static script variables; artifacts remain tracked inputs."),
        "_barf": attrs.exec_dep(default = "root//buck/tools/barf:barf", providers = [RunInfo]),
    },
    doc = "Runs one HTTP scenario script with bounded requests and no retries.",
)

def barf_test(**kwargs):
    _barf_test(**srclint.attach("barf_test", kwargs))

barf = struct(
    test = barf_test,
)
