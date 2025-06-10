# SPDX-FileCopyrightText: © 2024-2025 Austin Seipp
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
        url = f'https://github.com/denoland/deno/releases/download/v{version}/deno-{triple}.zip'
        native.http_archive(
            name = f'{version}-{triple}',
            sha256 = sha256,
            type = 'zip',
            urls = [ url ],
            visibility = [],
        )

    native.alias(
        name = f'{version}.zip',
        actual = select({
            'config//cpu:arm64': select({
                'config//os:linux': f':{version}-aarch64-unknown-linux-gnu',
                'config//os:macos': f':{version}-aarch64-apple-darwin',
            }),
            'config//cpu:x86_64': select({
                'config//os:linux': f':{version}-x86_64-unknown-linux-gnu',
                'config//os:windows': f':{version}-x86_64-pc-windows-msvc',
            }),
        }),
    )

def _deno_binary_impl(ctx: AnalysisContext) -> list[Provider]:
    deno = ctx.attrs._deno_toolchain[DenoToolchain].deno

    unstable_features = map(lambda x: f'--unstable-{x}', ctx.attrs.unstable_features)
    permissions = map(lambda x: f'--allow-{x}', ctx.attrs.permissions)

    output = ctx.actions.declare_output("{}.exe".format(ctx.label.name))
    ctx.actions.run(
        cmd_args([
            deno,
            "compile",
            "--output",
            output.as_output(),
        ] + unstable_features
          + permissions
        + [
            ctx.attrs.main,
        ]),
        category = "deno_compile",
        allow_cache_upload = True,
    )

    # Create lint subtarget - lint entire directory to catch all TypeScript files
    config_args = []
    if ctx.attrs.config:
        config_args = ["--config", ctx.attrs.config]
    
    lint_cmd = cmd_args([
        deno,
        "lint",
    ] + config_args)

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
            ])
        )
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
    }
)

def _deno_test_impl(ctx: AnalysisContext) -> list[Provider]:
    deno = ctx.attrs._deno_toolchain[DenoToolchain].deno
    
    unstable_features = map(lambda x: f'--unstable-{x}', ctx.attrs.unstable_features)
    permissions = map(lambda x: f'--allow-{x}', ctx.attrs.permissions)
    
    config_args = []
    if ctx.attrs.config:
        config_args = ["--config", ctx.attrs.config]
    
    cmd = cmd_args([
        deno,
        "test",
    ] + config_args + unstable_features + permissions + ctx.attrs.srcs)
    
    # Create lint subtarget - lint entire directory to catch all TypeScript files
    lint_cmd = cmd_args([
        deno,
        "lint",
    ] + config_args)
    
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
        )
    ]

_deno_test = rule(
    impl = _deno_test_impl,
    attrs = {
        "srcs": attrs.list(attrs.source()),
        "config": attrs.option(attrs.source(), default = None),
        "unstable_features": attrs.list(attrs.string(), default = []),
        "permissions": attrs.list(attrs.string(), default = []),
        "_deno_toolchain": attrs.toolchain_dep(default = "toolchains//:deno", providers = [DenoToolchain]),
    }
)

deno = struct(
    binary = _deno_binary,
    test = _deno_test,
)
