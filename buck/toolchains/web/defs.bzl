# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

"""Runtime-neutral JavaScript/TypeScript build rules."""

load("@toolchains//deno:toolchain.bzl", "DenoToolchain")
load("@toolchains//web:toolchain.bzl", "WebToolchain", "web_toolchain_attr")

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
