# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

"""Runtime-neutral JavaScript/TypeScript build rules."""

load("@prelude//:paths.bzl", "paths")
load("@toolchains//deno:toolchain.bzl", "DenoToolchain")
load("@toolchains//js:units.bzl", "UNIT_ATTRS", "dedupe", "is_code", "make_unit", "target_label", "with_tests")
load("@toolchains//web:toolchain.bzl", "WebToolchain", "web_toolchain_attr")

WebBundleInfo = provider(
    doc = "ESM bundle, optional authored map, and external wasm artifacts.",
    fields = {
        "bundle": provider_field(typing.Any),
        "sourcemap": provider_field(typing.Any),
        "wasm": provider_field(dict[str, typing.Any]),
    },
)

def _is_test_file(path: str) -> bool:
    base = paths.basename(path)
    for suffix in [".ts", ".tsx", ".js", ".mjs", ".mts", ".jsx"]:
        if base.endswith(suffix):
            stem = base[:-len(suffix)]
            return stem == "test" or stem.endswith("_test") or stem.endswith(".test")
    return False

def _web_deno_test_impl(ctx: AnalysisContext) -> list[Provider]:
    unit = make_unit(ctx, ctx.attrs.srcs, {}, None, ctx.attrs.fake_runtime)
    code = [src for src in ctx.attrs.srcs if is_code(src.short_path)]
    roots = [src for src in code if _is_test_file(src.short_path)] or code
    if not roots:
        # `deno test` with no files would collect tests from the working
        # directory, which is the whole project.
        fail("{}: srcs has no code to test".format(target_label(ctx.label)))

    runtime_config = unit.config
    for record in [unit.record] + list(unit.closure.traverse()):
        if record.generated or record.svelte_runtime:
            runtime_dir = ctx.actions.declare_output("web/test-runtime", dir = True)
            runtime_config = runtime_dir.project("deno.json")
            ctx.actions.run(
                cmd_args(
                    unit.toolchain.driver,
                    "config",
                    "--manifest",
                    unit.manifest,
                    "--view",
                    "server",
                    "--out-dir",
                    runtime_dir.as_output(),
                    ["--fake-runtime"] if ctx.attrs.fake_runtime else [],
                    hidden = unit.inputs,
                ),
                category = "web_deno_test_config",
            )
            break

    # The stamp checks authored code/projections; execution uses server modules.
    command = cmd_args(
        unit.toolchain.deno,
        "test",
        "--no-check",
        "--config",
        runtime_config,
        ["--allow-{}".format(p) for p in ctx.attrs.permissions],
        roots,
        hidden = [unit.stamp, unit.inputs, ctx.attrs.data],
    )
    return [
        DefaultInfo(default_output = unit.stamp, sub_targets = unit.sub_targets),
        RunInfo(args = command),
        ExternalRunnerTestInfo(
            type = "custom",
            command = [command],
            env = unit.env | ctx.attrs.env,
        ),
    ]

_web_deno_test = rule(
    impl = _web_deno_test_impl,
    attrs = UNIT_ATTRS | {
        "data": attrs.list(attrs.source(allow_directory = True), default = []),
        # A `$(location ...)` value makes that artifact an input of the test.
        "env": attrs.dict(attrs.string(), attrs.arg(), default = {}),
        "fake_runtime": attrs.bool(default = False),
        "permissions": attrs.list(attrs.string(), default = []),
    },
)

def _web_bundle_impl(ctx: AnalysisContext) -> list[Provider]:
    srcs = dedupe([ctx.attrs.main] + ctx.attrs.srcs)
    unit = make_unit(ctx, srcs, {}, None, False)
    output = ctx.actions.declare_output("{}.js".format(ctx.label.name))
    sourcemap = ctx.actions.declare_output("{}.js.map".format(ctx.label.name)) if ctx.attrs.minify else None
    ctx.actions.run(
        cmd_args(
            unit.toolchain.driver,
            "bundle",
            "--manifest",
            unit.manifest,
            "--config",
            unit.config,
            "--deno",
            unit.toolchain.deno,
            "--native",
            unit.toolchain.native,
            "--main",
            ctx.attrs.main,
            "--out",
            output.as_output(),
            ["--minify"] if ctx.attrs.minify else [],
            hidden = [unit.stamp, unit.inputs] + ([sourcemap.as_output()] if sourcemap else []),
        ),
        category = "web_bundle",
        allow_cache_upload = True,
    )
    return [
        DefaultInfo(
            default_output = output,
            other_outputs = list(unit.wasm_modules.values()) + ([sourcemap] if sourcemap else []),
            sub_targets = unit.sub_targets | ({"map": [DefaultInfo(default_output = sourcemap)]} if sourcemap else {}),
        ),
        WebBundleInfo(bundle = output, sourcemap = sourcemap, wasm = unit.wasm_modules),
    ]

_web_bundle = rule(
    impl = _web_bundle_impl,
    attrs = UNIT_ATTRS | {
        "main": attrs.source(),
        # Deno bundles first; native Oxc then compresses/mangles the ESM and map.
        "minify": attrs.bool(default = False),
    },
)

def _web_browser_impl(ctx: AnalysisContext) -> list[Provider]:
    srcs = dedupe([ctx.attrs.main] + ctx.attrs.srcs)
    unit = make_unit(ctx, srcs, {}, None, False)
    directory = ctx.actions.declare_output("assets", dir = True)
    ctx.actions.run(
        cmd_args(
            unit.toolchain.driver,
            "assets",
            "--manifest",
            unit.manifest,
            "--config",
            unit.config,
            "--deno",
            unit.toolchain.deno,
            "--native",
            unit.toolchain.native,
            "--main",
            ctx.attrs.main,
            "--out-dir",
            directory.as_output(),
            ["--minify"] if ctx.attrs.minify else [],
            [cmd_args("--style", style) for style in ctx.attrs.styles],
            hidden = [unit.stamp, unit.inputs],
        ),
        category = "web_browser",
        allow_cache_upload = True,
    )
    return [DefaultInfo(default_output = directory, sub_targets = unit.sub_targets)]

_web_browser = rule(
    impl = _web_browser_impl,
    attrs = UNIT_ATTRS | {
        "main": attrs.source(),
        "minify": attrs.bool(default = False),
        # Compiled global CSS precedes reachable component styles.
        "styles": attrs.list(attrs.source(), default = []),
    },
)

def web_deno_test(name: str, **kwargs):
    """Explicit Deno test execution over declared authored sources."""
    if "lib" not in kwargs:
        kwargs["lib"] = ["deno.ns", "dom", "dom.iterable", "esnext"]
    _web_deno_test(name = name, **with_tests(name, kwargs, ["lint"]))

def web_bundle(name: str, **kwargs):
    """Checked ESM with explicit external imports and optional Oxc minification."""
    _web_bundle(name = name, **with_tests(name, kwargs, ["check", "lint"]))

def web_browser(name: str, **kwargs):
    """Checked client ESM/CSS/maps, with optional global styles before component CSS."""
    _web_browser(name = name, **with_tests(name, kwargs, ["check", "lint"]))

def _web_tool_impl(ctx: AnalysisContext) -> list[Provider]:
    toolchain = ctx.attrs._web_toolchain[WebToolchain]
    return [DefaultInfo(), RunInfo(args = getattr(toolchain, ctx.attrs.tool))]

web_tool = rule(
    impl = _web_tool_impl,
    attrs = {
        "tool": attrs.enum(["native", "driver"]),
        "_web_toolchain": web_toolchain_attr(),
    },
)

def _web_deno_impl(ctx: AnalysisContext) -> list[Provider]:
    return [DefaultInfo(), RunInfo(args = ctx.attrs._deno_toolchain[DenoToolchain].deno)]

web_deno = rule(
    impl = _web_deno_impl,
    attrs = {
        "_deno_toolchain": attrs.toolchain_dep(default = "toolchains//:deno", providers = [DenoToolchain]),
    },
    doc = "Exposes the explicit Deno checker/bundler/test backend.",
)

def _web_quality_impl(ctx: AnalysisContext) -> list[Provider]:
    toolchain = ctx.attrs._web_toolchain[WebToolchain]
    formatter = cmd_args(toolchain.driver, "format", "--native", toolchain.native, ctx.attrs.srcs)
    lint = cmd_args(toolchain.driver, "lint", "--native", toolchain.native, ctx.attrs.srcs)
    return [
        DefaultInfo(sub_targets = {
            "format": [
                DefaultInfo(),
                RunInfo(args = formatter),
                ExternalRunnerTestInfo(type = "custom", command = [cmd_args(formatter, "--check")]),
            ],
        }),
        RunInfo(args = lint),
        ExternalRunnerTestInfo(type = "custom", command = [lint]),
    ]

web_quality = rule(
    impl = _web_quality_impl,
    attrs = {
        "srcs": attrs.list(attrs.source(), default = []),
        "_web_toolchain": web_toolchain_attr(),
    },
    doc = "Native lint and opt-in formatting over explicit JS/TS/Svelte files, without a runtime.",
)

web = struct(
    bundle = web_bundle,
    browser = web_browser,
    deno_test = web_deno_test,
    quality = web_quality,
)
