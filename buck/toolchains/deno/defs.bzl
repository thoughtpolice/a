# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@toolchains//js:providers.bzl", "JsLibraryInfo", "JsLibraryTSet")
load("@toolchains//js:units.bzl", "merge_wasm")
load("@toolchains//web:toolchain.bzl", "WebToolchain", "web_toolchain_attr")
load(":toolchain.bzl", "DenoToolchain")

def _dependency_config(ctx: AnalysisContext):
    """Keep source configs untouched unless library exports need a merged map."""
    inputs = [ctx.attrs.srcs]
    if ctx.attrs.config:
        inputs.append(ctx.attrs.config)
    config_args = ["--config", ctx.attrs.config] if ctx.attrs.config else []
    if not ctx.attrs.deps:
        return struct(args = config_args, lint_args = config_args, inputs = inputs, sub_targets = {})

    closure = ctx.actions.tset(JsLibraryTSet, children = [dep[JsLibraryInfo].tset for dep in ctx.attrs.deps])
    merge_wasm(str(ctx.label), [dep[JsLibraryInfo].wasm for dep in ctx.attrs.deps])
    has_svelte = False
    for record in closure.traverse():
        if record.generated or record.svelte_runtime:
            has_svelte = True
    runtime = ctx.attrs._web_toolchain[WebToolchain].svelte_runtime if has_svelte else {}
    inputs.extend([
        closure.project_as_args("srcs"),
        runtime.values(),
        [dep[DefaultInfo].default_outputs for dep in ctx.attrs.deps],
    ])
    manifest = ctx.actions.write_json("deno/dependencies.json", {
        "libraries": closure.project_as_json("json"),
        "unit": {
            "label": str(ctx.label),
            "srcs": [],
            "exports": {},
            "wasm": {},
            "deps": [dep[JsLibraryInfo].label for dep in ctx.attrs.deps],
            "generated": None,
            "svelte_runtime": False,
        },
        "runtime": runtime,
        "platform": {"server_conditions": ["deno", "default"]},
    })
    directory = ctx.actions.declare_output("deno/config", dir = True)
    import_map = directory.project("import-map.json")
    ctx.actions.run(
        cmd_args(
            ctx.attrs._depconfig[RunInfo],
            "--manifest",
            manifest,
            "--out-dir",
            directory.as_output(),
            ["--config", ctx.attrs.config] if ctx.attrs.config else [],
            hidden = inputs,
        ),
        category = "deno_dependency_config",
    )
    inputs.append(directory)
    return struct(
        # Preserve the source config's workspace, package.json and node_modules
        # discovery origin. Only module maps are relocated into generated output.
        args = config_args + ["--import-map", import_map],
        # Deno lint has no --import-map flag and does not resolve source imports.
        lint_args = config_args,
        inputs = inputs,
        sub_targets = {"config": [DefaultInfo(default_output = directory)]},
    )

def _source_check(ctx: AnalysisContext, dependencies, sources, unstable_features, env = {}, data = []):
    """Check original roots against authentic types before runtime compilation."""
    stamp = ctx.actions.declare_output("deno/source-check.stamp")
    ctx.actions.run(
        cmd_args(
            ctx.attrs._depconfig[RunInfo],
            "--check-stamp",
            stamp.as_output(),
            "--command",
            ctx.attrs._deno_toolchain[DenoToolchain].deno,
            "check",
            dependencies.args,
            unstable_features,
            sources,
            hidden = [data, dependencies.inputs],
        ),
        category = "deno_source_check",
        env = {"DENO_NO_UPDATE_CHECK": "1"} | env,
    )
    return [stamp]

def _dependency_attrs():
    return {
        "deps": attrs.list(attrs.dep(providers = [JsLibraryInfo]), default = []),
        "_depconfig": attrs.exec_dep(default = "toolchains//deno:depconfig", providers = [RunInfo]),
        "_web_toolchain": web_toolchain_attr(),
    }

def download_deno(version: str, hashes: list[(str, str)]):
    for triple, sha256 in hashes:
        url = "https://github.com/denoland/deno/releases/download/v{version}/deno-{triple}.zip".format(version = version, triple = triple)
        native.http_archive(
            name = "{version}-{triple}".format(version = version, triple = triple),
            sha256 = sha256,
            type = "zip",
            urls = [url],
            visibility = [],
        )

    native.alias(
        name = "{version}.zip".format(version = version),
        actual = select({
            "config//cpu:arm64": select({
                "config//os:linux": ":{version}-aarch64-unknown-linux-gnu".format(version = version),
                "config//os:macos": ":{version}-aarch64-apple-darwin".format(version = version),
            }),
            "config//cpu:x86_64": select({
                "config//os:linux": ":{version}-x86_64-unknown-linux-gnu".format(version = version),
                "config//os:windows": ":{version}-x86_64-pc-windows-msvc".format(version = version),
            }),
        }),
    )

def _deno_binary_impl(ctx: AnalysisContext) -> list[Provider]:
    deno = ctx.attrs._deno_toolchain[DenoToolchain].deno
    dependencies = _dependency_config(ctx)
    config_args = dependencies.args

    unstable_features = map(lambda x: "--unstable-{x}".format(x = x), ctx.attrs.unstable_features)
    permissions = map(lambda x: "--allow-{x}".format(x = x), ctx.attrs.permissions)
    check_outputs = _source_check(ctx, dependencies, [ctx.attrs.main] + ctx.attrs.srcs, unstable_features) if ctx.attrs.deps else []

    output = ctx.actions.declare_output("{}.exe".format(ctx.label.name))
    ctx.actions.run(
        cmd_args([
                     deno,
                     "compile",
                     "--output",
                     output.as_output(),
                 ] + config_args + (["--no-check"] if check_outputs else []) + unstable_features +
                 permissions +
                 [
                     ctx.attrs.main,
                 ], hidden = [dependencies.inputs, check_outputs]),
        category = "deno_compile",
        allow_cache_upload = True,
        env = {
            "DENO_NO_UPDATE_CHECK": "1",
        },
    )

    # Create lint subtarget - lint source files for this target

    # Lint the main file and any additional source files
    files_to_lint = [ctx.attrs.main] + ctx.attrs.srcs
    lint_cmd = cmd_args([
        deno,
        "lint",
    ] + dependencies.lint_args + files_to_lint, hidden = dependencies.inputs)
    if ctx.attrs.lint_rules_exclude:
        lint_cmd.add("--rules-exclude=" + ",".join(ctx.attrs.lint_rules_exclude))

    return [
        DefaultInfo(
            default_output = output,
            sub_targets = {
                "lint": [
                    DefaultInfo(),
                    ExternalRunnerTestInfo(
                        type = "custom",
                        command = [lint_cmd],
                    ),
                ],
            } | dependencies.sub_targets,
        ),
        RunInfo(
            args = cmd_args([
                deno,
                ctx.attrs.type,
                config_args,
                unstable_features,
                permissions,
                ctx.attrs.main,
            ], hidden = [dependencies.inputs, output, check_outputs]),
        ),
    ]

_deno_binary = rule(
    impl = _deno_binary_impl,
    attrs = {
        "srcs": attrs.list(attrs.source(), default = []),
        "main": attrs.source(),
        "type": attrs.enum(["run", "serve"]),
        "config": attrs.option(attrs.source(), default = None),
        "unstable_features": attrs.list(attrs.string(), default = []),
        "permissions": attrs.list(attrs.string(), default = []),
        # Deno lint rules to switch off, for sources written to another runtime's conventions
        "lint_rules_exclude": attrs.list(attrs.string(), default = []),
        "_deno_toolchain": attrs.toolchain_dep(default = "toolchains//:deno", providers = [DenoToolchain]),
    } | _dependency_attrs(),
)

def _deno_test_impl(ctx: AnalysisContext) -> list[Provider]:
    deno = ctx.attrs._deno_toolchain[DenoToolchain].deno

    unstable_features = map(lambda x: "--unstable-{x}".format(x = x), ctx.attrs.unstable_features)
    permissions = map(lambda x: "--allow-{x}".format(x = x), ctx.attrs.permissions)

    dependencies = _dependency_config(ctx)
    config_args = dependencies.args

    # The runtime graph traverses private JSDoc omitted from npm archives;
    # the mandatory type-graph check validates exactly the same original roots.
    check_outputs = _source_check(
        ctx,
        dependencies,
        ctx.attrs.srcs,
        unstable_features,
        env = ctx.attrs.env,
        data = ctx.attrs.data,
    ) if ctx.attrs.deps else []

    cmd = cmd_args([
        deno,
        "test",
    ] + config_args + (["--no-check"] if check_outputs else []) + unstable_features + permissions + ctx.attrs.srcs)

    # Files the tests read at runtime rather than import: naming them keeps the
    # test's inputs complete without putting them on the command line.
    cmd.add(cmd_args(hidden = [ctx.attrs.data, dependencies.inputs, check_outputs]))

    # Create lint subtarget - lint test source files
    lint_cmd = cmd_args([
        deno,
        "lint",
    ] + dependencies.lint_args + ctx.attrs.srcs, hidden = dependencies.inputs)
    if ctx.attrs.lint_rules_exclude:
        lint_cmd.add("--rules-exclude=" + ",".join(ctx.attrs.lint_rules_exclude))

    return [
        DefaultInfo(
            default_outputs = check_outputs,
            sub_targets = {
                "lint": [
                    DefaultInfo(),
                    ExternalRunnerTestInfo(
                        type = "custom",
                        command = [lint_cmd],
                    ),
                ],
            } | dependencies.sub_targets,
        ),
        RunInfo(args = cmd),
        ExternalRunnerTestInfo(
            type = "custom",
            command = [cmd],
            env = {"DENO_NO_UPDATE_CHECK": "1"} | ctx.attrs.env,
        ),
    ]

_deno_test = rule(
    impl = _deno_test_impl,
    attrs = {
        "srcs": attrs.list(attrs.source()),
        "config": attrs.option(attrs.source(), default = None),
        # A `$(location ...)` value makes that artifact an input of the test,
        # so a test can be handed a built file through the environment.
        "env": attrs.dict(attrs.string(), attrs.arg(), default = {}),
        "data": attrs.list(attrs.source(allow_directory = True), default = []),
        "unstable_features": attrs.list(attrs.string(), default = []),
        "permissions": attrs.list(attrs.string(), default = []),
        # Deno lint rules to switch off, for sources written to another runtime's conventions
        "lint_rules_exclude": attrs.list(attrs.string(), default = []),
        "_deno_toolchain": attrs.toolchain_dep(default = "toolchains//:deno", providers = [DenoToolchain]),
    } | _dependency_attrs(),
)

# Macro wrappers that automatically add lint tests
def deno_binary(**kwargs):
    """
    Wrapper for deno.binary that automatically adds lint test to tests parameter.
    """
    name = kwargs.get("name")
    tests = kwargs.pop("tests", [])

    # Automatically add lint test if not already present
    lint_test = ":{}[lint]".format(name)
    if lint_test not in tests:
        tests = tests + [lint_test]

    _deno_binary(
        tests = tests,
        **kwargs
    )

def deno_test(**kwargs):
    """
    Wrapper for deno.test that automatically adds lint test to tests parameter.
    """
    name = kwargs.get("name")
    tests = kwargs.pop("tests", [])

    # Automatically add lint test if not already present
    lint_test = ":{}[lint]".format(name)
    if lint_test not in tests:
        tests = tests + [lint_test]

    _deno_test(
        tests = tests,
        **kwargs
    )

def _deno_run_impl(ctx: AnalysisContext) -> list[Provider]:
    deno = ctx.attrs._deno_toolchain[DenoToolchain].deno
    if ctx.attrs.package_id and ctx.attrs.deps:
        fail("deno.run: deps require a source entry point, not package_id")
    dependencies = _dependency_config(ctx)
    config_args = dependencies.args
    check_outputs = []
    if ctx.attrs.src and ctx.attrs.check and ctx.attrs.deps:
        check_outputs = _source_check(
            ctx,
            dependencies,
            [ctx.attrs.src] + ctx.attrs.srcs,
            map(lambda x: "--unstable-{x}".format(x = x), ctx.attrs.unstable_features),
        )

    # Build command arguments
    cmd = cmd_args([deno, "run"])

    # Add unstable features
    for feature in ctx.attrs.unstable_features:
        cmd.add("--unstable-{feature}".format(feature = feature))

    # Add permissions
    for perm in ctx.attrs.permissions:
        cmd.add("--allow-{perm}".format(perm = perm))

    cmd.add(config_args)

    # Add the source (either local file or package ID)
    if ctx.attrs.src:
        cmd.add(ctx.attrs.src)
    else:
        cmd.add(ctx.attrs.package_id)

    # The modules the entry point reaches: they are inputs of the run even
    # though only the entry point is named on the command line.
    cmd.add(cmd_args(hidden = [dependencies.inputs, check_outputs]))

    # Create lint subtarget only if src is provided
    sub_targets = dict(dependencies.sub_targets)
    if ctx.attrs.src:
        files = [ctx.attrs.src] + ctx.attrs.srcs
        lint_cmd = cmd_args([
            deno,
            "lint",
        ] + dependencies.lint_args + files, hidden = dependencies.inputs)
        if ctx.attrs.lint_rules_exclude:
            lint_cmd.add("--rules-exclude=" + ",".join(ctx.attrs.lint_rules_exclude))

        sub_targets["lint"] = [
            DefaultInfo(),
            ExternalRunnerTestInfo(
                type = "custom",
                command = [lint_cmd],
            ),
        ]

        # ``deno run`` never type-checks, so without this the entry point and
        # everything below it would ship unchecked.
        if ctx.attrs.check:
            if check_outputs:
                check_cmd = cmd_args(ctx.attrs._depconfig[RunInfo], "--show-stamp", check_outputs[0])
            else:
                check_cmd = cmd_args([
                    deno,
                    "check",
                ] + config_args + files, hidden = dependencies.inputs)

            sub_targets["check"] = [
                DefaultInfo(default_outputs = check_outputs),
                ExternalRunnerTestInfo(
                    type = "custom",
                    command = [check_cmd],
                    env = {"DENO_NO_UPDATE_CHECK": "1"},
                ),
            ]

    # Create RunInfo
    return [
        DefaultInfo(default_outputs = check_outputs, sub_targets = sub_targets),
        RunInfo(args = cmd),
    ]

_deno_run = rule(
    impl = _deno_run_impl,
    attrs = {
        "src": attrs.option(attrs.source(), default = None),
        "srcs": attrs.list(attrs.source(), default = []),
        "package_id": attrs.option(attrs.string(), default = None),
        "check": attrs.bool(default = False),
        "permissions": attrs.list(attrs.string(), default = []),
        "unstable_features": attrs.list(attrs.string(), default = []),
        "config": attrs.option(attrs.source(), default = None),
        # Deno lint rules to switch off, for sources written to another runtime's conventions
        "lint_rules_exclude": attrs.list(attrs.string(), default = []),
        "_deno_toolchain": attrs.toolchain_dep(default = "toolchains//:deno", providers = [DenoToolchain]),
    } | _dependency_attrs(),
)

def deno_run(name, src = None, package_id = None, **kwargs):
    """
    Run a Deno script directly or execute an npm package via Deno.

    Either 'src' or 'package_id' must be specified (but not both):
    - src: Path to a TypeScript/JavaScript file to run directly
    - package_id: NPM package specifier (e.g., "npm:prettier@3.0.0")

    Args:
        name: Name of the target
        src: Source file to run (mutually exclusive with package_id)
        package_id: NPM package to run (mutually exclusive with src)
        config: Optional deno.json config file
        unstable_features: List of unstable features to enable
        permissions: List of permissions to allow
    """
    if (src == None) == (package_id == None):
        fail("deno_run: Exactly one of 'src' or 'package_id' must be provided")
    if package_id != None and kwargs.get("deps"):
        fail("deno.run: deps require a source entry point, not package_id")

    # Add lint test if src is provided
    tests = kwargs.pop("tests", [])
    if src:
        lint_test = ":{}[lint]".format(name)
        if lint_test not in tests:
            tests = tests + [lint_test]
        if kwargs.get("check"):
            check_test = ":{}[check]".format(name)
            if check_test not in tests:
                tests = tests + [check_test]

    # Build kwargs for the rule, only including non-None values
    rule_kwargs = {
        "name": name,
        "tests": tests,
    }

    if src != None:
        rule_kwargs["src"] = src
    if package_id != None:
        rule_kwargs["package_id"] = package_id

    # Merge with remaining kwargs
    rule_kwargs.update(kwargs)

    # Call underlying rule
    _deno_run(**rule_kwargs)

def _deno_bundle_impl(ctx: AnalysisContext) -> list[Provider]:
    deno = ctx.attrs._deno_toolchain[DenoToolchain].deno

    unstable_features = map(lambda x: "--unstable-{x}".format(x = x), ctx.attrs.unstable_features)

    dependencies = _dependency_config(ctx)
    config_args = dependencies.args
    check_outputs = _source_check(ctx, dependencies, [ctx.attrs.main] + ctx.attrs.srcs, unstable_features) if ctx.attrs.deps and ctx.attrs.check else []

    # ``deno bundle`` always emits JavaScript, even when the entry point is
    # TypeScript. Give the artifact its real extension so downstream rules can
    # consume it without disguising source TypeScript as a runtime module.
    output = ctx.actions.declare_output("{}.js".format(ctx.label.name))

    check_args = ["--no-check"] if check_outputs else (["--check"] if ctx.attrs.check else [])
    minify_args = ["--minify"] if ctx.attrs.minify else []
    external_args = []
    for module in ctx.attrs.external:
        external_args.extend(["--external", module])

    # Build the command with hidden dependencies on all source files
    cmd = cmd_args(
        [
            deno,
            "bundle",
        ] + config_args +
        unstable_features +
        check_args + minify_args + external_args +
        [
            "--format",
            "esm",
            "--platform",
            ctx.attrs.platform,
            ctx.attrs.main,
            "--output",
            output.as_output(),
        ],
        hidden = [dependencies.inputs, check_outputs],
    )

    ctx.actions.run(
        cmd,
        category = "deno_bundle",
        allow_cache_upload = True,
        env = {
            "DENO_NO_UPDATE_CHECK": "1",
        },
    )

    # Create lint subtarget - lint source files for this target
    files_to_lint = [ctx.attrs.main] + ctx.attrs.srcs
    lint_cmd = cmd_args([
        deno,
        "lint",
    ] + dependencies.lint_args + files_to_lint, hidden = dependencies.inputs)
    if ctx.attrs.lint_rules_exclude:
        lint_cmd.add("--rules-exclude=" + ",".join(ctx.attrs.lint_rules_exclude))

    return [
        DefaultInfo(
            default_output = output,
            sub_targets = {
                "lint": [
                    DefaultInfo(),
                    ExternalRunnerTestInfo(
                        type = "custom",
                        command = [lint_cmd],
                    ),
                ],
            } | dependencies.sub_targets,
        ),
    ]

_deno_bundle = rule(
    impl = _deno_bundle_impl,
    attrs = {
        "srcs": attrs.list(attrs.source(), default = []),
        "main": attrs.source(),
        "config": attrs.option(attrs.source(), default = None),
        # Preserve runtime-owned ESM imports, e.g. celld's cloudflare: modules.
        "external": attrs.list(attrs.string(), default = []),
        "check": attrs.bool(default = True),
        # Strip comments and whitespace from the output. A runtime that fetches
        # the bundle over the network (celld loads a script from its bucket on
        # every node start) benefits from the smaller file.
        "minify": attrs.bool(default = False),
        "platform": attrs.enum(["browser", "deno"], default = "deno"),
        "unstable_features": attrs.list(attrs.string(), default = []),
        # Deno lint rules to switch off, for sources written to another runtime's conventions
        "lint_rules_exclude": attrs.list(attrs.string(), default = []),
        "_deno_toolchain": attrs.toolchain_dep(default = "toolchains//:deno", providers = [DenoToolchain]),
    } | _dependency_attrs(),
)

def deno_bundle(**kwargs):
    """
    Bundle a Deno TypeScript/JavaScript application into a single JavaScript
    ESM file. Type checking is enabled by default. ``external`` preserves the
    listed module specifiers for the destination runtime instead of bundling
    them; callers must provide any ambient declarations needed to type-check.
    ``minify`` strips comments and whitespace from the output.
    """
    name = kwargs.get("name")
    tests = kwargs.pop("tests", [])

    # Automatically add lint test if not already present
    lint_test = ":{}[lint]".format(name)
    if lint_test not in tests:
        tests = tests + [lint_test]

    _deno_bundle(
        tests = tests,
        **kwargs
    )

def _deno_fmt_check_impl(ctx: AnalysisContext) -> list[Provider]:
    deno = ctx.attrs._deno_toolchain[DenoToolchain].deno

    config_args = []
    if ctx.attrs.config:
        config_args = ["--config", ctx.attrs.config]

    cmd = cmd_args([
        deno,
        "fmt",
        "--check",
    ] + config_args + ctx.attrs.srcs)

    return [
        DefaultInfo(),
        RunInfo(args = cmd),
        ExternalRunnerTestInfo(
            type = "custom",
            command = [cmd],
            env = {"DENO_NO_UPDATE_CHECK": "1"},
        ),
    ]

_deno_fmt_check = rule(
    impl = _deno_fmt_check_impl,
    attrs = {
        "srcs": attrs.list(attrs.source()),
        "config": attrs.option(attrs.source(), default = None),
        "_deno_toolchain": attrs.toolchain_dep(default = "toolchains//:deno", providers = [DenoToolchain]),
    },
)

def deno_fmt_check(**kwargs):
    """
    Fail when ``deno fmt`` would rewrite one of ``srcs``. The repository's own
    formatter does not know TypeScript, so a package that wants its sources
    kept formatted declares this test and runs ``deno fmt`` by hand.
    """
    _deno_fmt_check(**kwargs)

deno = struct(
    binary = deno_binary,
    test = deno_test,
    run = deno_run,
    bundle = deno_bundle,
    fmt_check = deno_fmt_check,
    # Also expose raw rules if needed
    raw_binary = _deno_binary,
    raw_test = _deno_test,
    raw_bundle = _deno_bundle,
    raw_fmt_check = _deno_fmt_check,
)
