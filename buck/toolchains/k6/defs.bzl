# SPDX-FileCopyrightText: © 2025 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

K6Toolchain = provider(fields = {
    "k6": provider_field(typing.Any),
})

def _k6_toolchain_impl(ctx: AnalysisContext) -> list[Provider]:
    k6 = cmd_args(ctx.attrs.k6)
    return [
        DefaultInfo(),
        K6Toolchain(k6 = k6),
    ]

k6_toolchain = rule(
    impl = _k6_toolchain_impl,
    attrs = {
        "k6": attrs.list(attrs.arg()),
    },
    is_toolchain_rule = True,
)

def download_k6(version: str, hashes: list[(str, str)]):
    for triple, sha256 in hashes:
        url = f'https://github.com/grafana/k6/releases/download/v{version}/k6-v{version}-{triple}.tar.gz'
        native.http_archive(
            name = f'{version}-{triple}',
            sha256 = sha256,
            type = 'tar.gz',
            urls = [ url ],
            visibility = [],
        )

    native.alias(
        name = f'{version}.tar.gz',
        actual = select({
            'config//cpu:arm64': f':{version}-linux-arm64',
            'config//cpu:x86_64': f':{version}-linux-amd64',
        }),
    )

def _k6_run_impl(ctx: AnalysisContext) -> list[Provider]:
    k6 = ctx.attrs._k6_toolchain[K6Toolchain].k6

    # Build command arguments
    cmd = cmd_args([k6, "run"])

    # Add optional parameters
    if ctx.attrs.vus != None:
        cmd.add("--vus", str(ctx.attrs.vus))

    if ctx.attrs.duration != None:
        cmd.add("--duration", ctx.attrs.duration)

    if ctx.attrs.iterations != None:
        cmd.add("--iterations", str(ctx.attrs.iterations))

    if ctx.attrs.out != None:
        cmd.add("--out", ctx.attrs.out)

    # Add the script
    cmd.add(ctx.attrs.script)

    # Create RunInfo
    return [
        DefaultInfo(),
        RunInfo(args = cmd)
    ]

k6_run = rule(
    impl = _k6_run_impl,
    attrs = {
        "script": attrs.source(),
        "vus": attrs.option(attrs.int(), default = None),
        "duration": attrs.option(attrs.string(), default = None),
        "iterations": attrs.option(attrs.int(), default = None),
        "out": attrs.option(attrs.string(), default = None),
        "_k6_toolchain": attrs.toolchain_dep(default = "toolchains//:k6", providers = [K6Toolchain]),
    }
)
