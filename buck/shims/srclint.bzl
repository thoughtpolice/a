# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

"""Per-target source checks: SPDX headers, whitespace and Starlark loads.

Every target declared through the shims gets a sibling test,
`<name>.srclint`, over the source files it names: a rust_binary's .rs files,
a cxx_library's sources and headers, and so on. The first shim call in a
package also adds `__starlark.srclint` over the package's own BUILD, PACKAGE,
.bzl and .bxl files; a package with no shim calls asks for it with
`lint_package`. Files no target consumes are checked only if a `lint_files`
target names them. buck/tools/srclint/coverage.bxl lists the files the build
reads that no test checks.

So the checks cover what the build actually uses, each test reads only its
own target's files, and a change selects only the tests of the targets whose
sources it touched. The checking itself is a cached build action (see
buck/tools/srclint), so an unchanged target's files are never read again.

Which checks a file gets depends on what it is. Every text file is checked
for trailing whitespace and a final newline. A file in a language srclint
knows the comment syntax of needs an SPDX header; documents, data and
configuration in formats without comments do not. A Starlark file's loads
must name .bzl files as targets.

A target takes a `srclint` argument to adjust its test:

    srclint = False                                     # no test at all
    srclint = {"spdx_exclude": glob(["vendor/**"])}     # someone else's header
    srclint = {"whitespace_exclude": ["golden.out"]}    # whitespace is data

A package turns off the tests of its targets' sources, and those of every
package below it, with `pkg.srclint(sources = False)` in its PACKAGE file.
Vendored packages, those whose `pkg.info` says `vendored = True`, have them
off already. Their build files are this repository's own, so the Starlark
test stays on, all but its SPDX check: such a file is often adapted from
upstream's, and keeps upstream's copyright line.
"""

# Suffix of the test generated for each target.
_SUFFIX = ".srclint"

# The test over a package's own Starlark files.
_STARLARK_TARGET = "__starlark" + _SUFFIX

_CHECKER = "root//buck/tools/srclint:srclint"

# MARK: Rule

def _srclint_test_impl(ctx: AnalysisContext) -> list[Provider]:
    # Only files in the repository. A generated source is checked, if at all,
    # where its generator's sources are.
    files = {}
    for src in ctx.attrs.srcs:
        if src.is_source:
            files.setdefault(src.short_path, src)

    excluded = {}
    for check, excludes in [("spdx", ctx.attrs.spdx_exclude), ("whitespace", ctx.attrs.whitespace_exclude)]:
        excluded[check] = {}
        for src in excludes:
            if src.short_path not in files:
                fail("{}: {}_exclude names {}, which is not one of the files it checks".format(ctx.label.raw_target(), check, src.short_path))
            excluded[check][src.short_path] = True

    manifest = ctx.actions.write_json(
        "srclint.json",
        {
            "files": [
                {
                    "path": src,
                    "spdx": path not in excluded["spdx"],
                    "whitespace": path not in excluded["whitespace"],
                }
                for path, src in sorted(files.items())
            ],
            "label": str(ctx.label.raw_target()),
        },
        with_inputs = True,
    )
    checker = ctx.attrs._checker[RunInfo]
    report = ctx.actions.declare_output("srclint-report.json")
    ctx.actions.run(
        cmd_args(checker, "check", "--manifest", manifest, "--out", report.as_output()),
        category = "srclint",
    )

    # The action passes whatever it finds, so a failing report is cached like
    # a passing one; the test replays it and fails on its problems.
    command = cmd_args(checker, "report", report)
    return [
        DefaultInfo(default_output = report),
        RunInfo(args = command),
        ExternalRunnerTestInfo(
            type = "custom",
            command = [command],
            labels = ctx.attrs.labels,
        ),
    ]

srclint_test = rule(
    impl = _srclint_test_impl,
    attrs = {
        # So `buck2 test --include srclint` selects these tests and no others.
        "labels": attrs.list(attrs.string(), default = ["srclint"]),
        "spdx_exclude": attrs.list(attrs.source(), default = []),
        "srcs": attrs.list(attrs.source(), default = []),
        "whitespace_exclude": attrs.list(attrs.source(), default = []),
        "_checker": attrs.exec_dep(default = _CHECKER, providers = [RunInfo]),
    },
)

# MARK: Which attributes hold sources

# The attributes of each rule that name its source files, by the rule name the
# shim or macro passes to `attach`. An attribute holds a path, a list of
# paths or (path, flags) tuples, or a dict whose values are paths; ":keys"
# marks a dict whose keys are. Rules not listed here, such as downloads and
# images, name no sources of their own.
_SOURCE_ATTRS = {
    "copy_files": ["srcs"],
    "csharp_binary": ["srcs"],
    "csharp_library": ["srcs"],
    "csharp_test": ["srcs"],
    "cxx_binary": ["srcs", "headers", "raw_headers"],
    "cxx_library": ["srcs", "headers", "exported_headers", "raw_headers"],
    "deno_binary": ["main", "srcs", "config"],
    "deno_bundle": ["main", "srcs", "config"],
    "deno_run": ["src", "srcs", "config"],
    "deno_test": ["srcs", "config"],
    "erlang_app": ["srcs", "includes"],
    "export_file": ["src"],
    "filecheck_lit": ["srcs"],
    "filecheck_test": ["check"],
    "filegroup": ["srcs"],
    "genrule": ["srcs"],
    "go_binary": ["srcs"],
    "go_library": ["srcs"],
    "go_test": ["srcs"],
    "hurl_test": ["src"],
    "lean_binary": ["srcs"],
    "lean_library": ["srcs"],
    "lean_test": ["srcs"],
    "ncc_bundle": ["srcs"],
    "ocaml_binary": ["srcs"],
    "ocaml_library": ["srcs"],
    "python_binary": ["main", "srcs"],
    "python_bootstrap_binary": ["main"],
    "python_bootstrap_library": ["srcs"],
    "python_library": ["srcs"],
    "rust_binary": ["srcs", "mapped_srcs:keys"],
    "rust_library": ["srcs", "mapped_srcs:keys"],
    "rust_test": ["srcs", "mapped_srcs:keys"],
    "tar_file": ["srcs"],
    "uv_python_binary": ["main", "srcs"],
    "uv_python_test": ["script"],
}

def _is_label(s: str) -> bool:
    return s.startswith(":") or "//" in s

def _paths(value, keys: bool) -> list[str]:
    """The file paths in one resolved attribute value, without labels."""
    if value == None:
        return []
    if isinstance(value, str):
        items = [value]
    elif isinstance(value, dict):
        items = value.keys() if keys else value.values()
    else:
        items = value
    paths = []
    for item in items:
        if isinstance(item, tuple):
            item = item[0]
        if isinstance(item, str) and not _is_label(item):
            paths.append(item)
    return paths

def _sources(rule_name: str, kwargs: dict):
    """The source files rule_name's kwargs name: a list, or a select of them."""
    plain = []
    selects = []
    for spec in _SOURCE_ATTRS.get(rule_name, []):
        attr, _, shape = spec.partition(":")
        keys = shape == "keys"
        value = kwargs.get(attr)
        if attr == "src" and rule_name == "export_file" and value == None:
            value = kwargs["name"]
        if isinstance(value, Select):
            selects.append(select_map(value, lambda v, keys = keys: _paths(v, keys)))
        else:
            plain.extend(_paths(value, keys))
    if not selects:
        return plain
    result = plain
    for s in selects:
        result = result + s
    return result

# MARK: Attaching tests

def _sources_enabled() -> bool:
    if read_package_value("meta.vendor") != None:
        return False
    return read_package_value("srclint.sources") != False

# Every directory of the package. A glob wildcard never matches a path
# component that starts with ".", so the dot directories need their own.
_STARLARK_DIRS = ["**/", ".*/**/", "**/.*/**/"]

def _package_test():
    """Adds the test over the package's own Starlark files, once."""
    if rule_exists(_STARLARK_TARGET):
        return

    # The glob stops at subpackages, so each Starlark file belongs to the
    # test of exactly one package: the nearest one at or above it. That
    # includes a PACKAGE file in a directory with no BUILD file of its own,
    # and the .bzl files of a directory of rule definitions.
    srcs = glob(["BUILD", "BUCK"] + [
        prefix + name
        for prefix in _STARLARK_DIRS
        for name in ["PACKAGE", "*.bzl", "*.bxl"]
    ])
    srclint_test(
        name = _STARLARK_TARGET,
        srcs = srcs,
        # Where the sources are someone else's, the build files are often
        # adapted from theirs, and keep their copyright line.
        spdx_exclude = [] if _sources_enabled() else srcs,
    )

def attach(rule_name: str, kwargs: dict) -> dict:
    """Adds the srclint tests for a target about to be declared.

    Pops the target's `srclint` argument and returns the rest of kwargs.
    """
    options = kwargs.pop("srclint", None)
    _package_test()
    if options == False or not _sources_enabled():
        return kwargs
    options = options or {}
    unknown = [k for k in options if k not in ("spdx_exclude", "whitespace_exclude")]
    if unknown:
        fail("srclint: unknown options {}; expected spdx_exclude or whitespace_exclude".format(unknown))

    srcs = _sources(rule_name, kwargs)
    if srcs == [] and not options:
        return kwargs
    name = kwargs["name"] + _SUFFIX

    # A macro can declare more than one target through the shims under the
    # same name, as the Lean macros do; only one may bring sources to check.
    if rule_exists(name):
        fail("srclint: {} declares sources to check twice".format(kwargs["name"]))

    # The test runs where the target builds: a platform's sources can be a
    # select() with no branch for the others.
    compatibility = {
        attr: kwargs[attr]
        for attr in ("target_compatible_with", "compatible_with")
        if kwargs.get(attr) != None
    }
    srclint_test(
        name = name,
        srcs = srcs,
        spdx_exclude = options.get("spdx_exclude", []),
        whitespace_exclude = options.get("whitespace_exclude", []),
        **compatibility
    )
    return kwargs

def lint_files(
        name: str,
        srcs: list[str],
        spdx_exclude: list[str] = [],
        whitespace_exclude: list[str] = []):
    """Checks files the shims do not see.

    Dotfiles, Nix expressions, editor and CI configuration and the like are
    read by something other than the build, so no target names them; the
    scripts and configuration a toolchain rule reads are named by a rule the
    shims do not wrap. This names them for the checks.
    """
    lint_package()
    srclint_test(
        name = name,
        srcs = srcs,
        spdx_exclude = spdx_exclude,
        whitespace_exclude = whitespace_exclude,
    )

def lint_package():
    """Checks the package's own Starlark files.

    Any shim call does this; a package that declares its targets only with
    rules from elsewhere, as toolchain packages do, calls it itself.
    """
    _package_test()

srclint = struct(
    attach = attach,
    lint_files = lint_files,
    lint_package = lint_package,
)
