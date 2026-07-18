# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

DenoToolchain = provider(fields = {
    "deno": provider_field(typing.Any),
})

def _deno_toolchain_impl(ctx: AnalysisContext) -> list[Provider]:
    deno = cmd_args(ctx.attrs.deno)
    return [
        DefaultInfo(),
        DenoToolchain(deno = deno),
    ]

deno_toolchain = rule(
    impl = _deno_toolchain_impl,
    attrs = {
        "deno": attrs.list(attrs.arg()),
    },
    is_toolchain_rule = True,
)

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

    unstable_features = map(lambda x: "--unstable-{x}".format(x = x), ctx.attrs.unstable_features)
    permissions = map(lambda x: "--allow-{x}".format(x = x), ctx.attrs.permissions)

    output = ctx.actions.declare_output("{}.exe".format(ctx.label.name))
    ctx.actions.run(
        cmd_args([
                     deno,
                     "compile",
                     "--output",
                     output.as_output(),
                 ] + unstable_features +
                 permissions +
                 [
                     ctx.attrs.main,
                 ]),
        category = "deno_compile",
        allow_cache_upload = True,
        env = {
            "DENO_NO_UPDATE_CHECK": "1",
        },
    )

    # Create lint subtarget - lint source files for this target
    config_args = []
    if ctx.attrs.config:
        config_args = ["--config", ctx.attrs.config]

    # Lint the main file and any additional source files
    files_to_lint = [ctx.attrs.main] + ctx.attrs.srcs
    lint_cmd = cmd_args([
        deno,
        "lint",
    ] + config_args + files_to_lint)

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
            },
        ),
        RunInfo(
            args = cmd_args([
                deno,
                ctx.attrs.type,
                unstable_features,
                permissions,
                ctx.attrs.main,
            ]),
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
        "_deno_toolchain": attrs.toolchain_dep(default = "toolchains//:deno", providers = [DenoToolchain]),
    },
)

def _deno_test_impl(ctx: AnalysisContext) -> list[Provider]:
    deno = ctx.attrs._deno_toolchain[DenoToolchain].deno

    unstable_features = map(lambda x: "--unstable-{x}".format(x = x), ctx.attrs.unstable_features)
    permissions = map(lambda x: "--allow-{x}".format(x = x), ctx.attrs.permissions)

    config_args = []
    if ctx.attrs.config:
        config_args = ["--config", ctx.attrs.config]

    cmd = cmd_args([
        deno,
        "test",
    ] + config_args + unstable_features + permissions + ctx.attrs.srcs)

    # Create lint subtarget - lint test source files
    lint_cmd = cmd_args([
        deno,
        "lint",
    ] + config_args + ctx.attrs.srcs)

    return [
        DefaultInfo(
            sub_targets = {
                "lint": [
                    DefaultInfo(),
                    ExternalRunnerTestInfo(
                        type = "custom",
                        command = [lint_cmd],
                    ),
                ],
            },
        ),
        RunInfo(args = cmd),
        ExternalRunnerTestInfo(
            type = "custom",
            command = [cmd],
        ),
    ]

_deno_test = rule(
    impl = _deno_test_impl,
    attrs = {
        "srcs": attrs.list(attrs.source()),
        "config": attrs.option(attrs.source(), default = None),
        "unstable_features": attrs.list(attrs.string(), default = []),
        "permissions": attrs.list(attrs.string(), default = []),
        "_deno_toolchain": attrs.toolchain_dep(default = "toolchains//:deno", providers = [DenoToolchain]),
    },
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

    # Build command arguments
    cmd = cmd_args([deno, "run"])

    # Add unstable features
    for feature in ctx.attrs.unstable_features:
        cmd.add("--unstable-{feature}".format(feature = feature))

    # Add permissions
    for perm in ctx.attrs.permissions:
        cmd.add("--allow-{perm}".format(perm = perm))

    # Add config if provided
    if ctx.attrs.config:
        cmd.add("--config", ctx.attrs.config)

    # Add the source (either local file or package ID)
    if ctx.attrs.src:
        cmd.add(ctx.attrs.src)
    else:
        cmd.add(ctx.attrs.package_id)

    # Create lint subtarget only if src is provided
    sub_targets = {}
    if ctx.attrs.src:
        config_args = []
        if ctx.attrs.config:
            config_args = ["--config", ctx.attrs.config]

        lint_cmd = cmd_args([
            deno,
            "lint",
        ] + config_args + [ctx.attrs.src])

        sub_targets["lint"] = [
            DefaultInfo(),
            ExternalRunnerTestInfo(
                type = "custom",
                command = [lint_cmd],
            ),
        ]

    # Create RunInfo
    return [
        DefaultInfo(sub_targets = sub_targets),
        RunInfo(args = cmd),
    ]

_deno_run = rule(
    impl = _deno_run_impl,
    attrs = {
        "src": attrs.option(attrs.source(), default = None),
        "package_id": attrs.option(attrs.string(), default = None),
        "permissions": attrs.list(attrs.string(), default = []),
        "unstable_features": attrs.list(attrs.string(), default = []),
        "config": attrs.option(attrs.source(), default = None),
        "_deno_toolchain": attrs.toolchain_dep(default = "toolchains//:deno", providers = [DenoToolchain]),
    },
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

    # Add lint test if src is provided
    tests = kwargs.pop("tests", [])
    if src:
        lint_test = ":{}[lint]".format(name)
        if lint_test not in tests:
            tests = tests + [lint_test]

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

    config_args = []
    if ctx.attrs.config:
        config_args = ["--config", ctx.attrs.config]

    output = ctx.actions.declare_output("{}.ts".format(ctx.label.name))

    # Build the command with hidden dependencies on all source files
    cmd = cmd_args(
        [
            deno,
            "bundle",
        ] + config_args +
        unstable_features +
        [
            ctx.attrs.main,
            "--output",
            output.as_output(),
        ],
        hidden = ctx.attrs.srcs,
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
    ] + config_args + files_to_lint)

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
            },
        ),
    ]

_deno_bundle = rule(
    impl = _deno_bundle_impl,
    attrs = {
        "srcs": attrs.list(attrs.source(), default = []),
        "main": attrs.source(),
        "config": attrs.option(attrs.source(), default = None),
        "unstable_features": attrs.list(attrs.string(), default = []),
        "_deno_toolchain": attrs.toolchain_dep(default = "toolchains//:deno", providers = [DenoToolchain]),
    },
)

def deno_bundle(**kwargs):
    """
    Bundle a Deno TypeScript/JavaScript application into a single file.
    This uses 'deno bundle' to create an amalgamated .ts file that includes
    all dependencies and can be run standalone with 'deno run' or 'deno serve'.
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

deno = struct(
    binary = deno_binary,
    test = deno_test,
    run = deno_run,
    bundle = deno_bundle,
    # Also expose raw rules if needed
    raw_binary = _deno_binary,
    raw_test = _deno_test,
    raw_bundle = _deno_bundle,
)
