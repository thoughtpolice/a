# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@toolchains//web/svelte:defs.bzl", "SvelteRuntimeInfo")

WebToolchain = provider(
    doc = "Native source tools, the runtime-neutral unit driver and the pinned Tailwind compiler.",
    fields = {
        "native": provider_field(typing.Any),
        "driver": provider_field(typing.Any),
        "svelte_runtime": provider_field(typing.Any),
        "tailwind_compiler": provider_field(typing.Any),
        "tailwind_runner": provider_field(typing.Any),
    },
)

def _web_toolchain_impl(ctx: AnalysisContext) -> list[Provider]:
    return [
        DefaultInfo(),
        WebToolchain(
            native = ctx.attrs.native[RunInfo].args,
            driver = ctx.attrs.driver[RunInfo].args,
            svelte_runtime = ctx.attrs.svelte_runtime[SvelteRuntimeInfo].packages,
            tailwind_compiler = ctx.attrs.tailwind_compiler[DefaultInfo].default_outputs[0],
            tailwind_runner = ctx.attrs.tailwind_runner[RunInfo].args,
        ),
    ]

web_toolchain = rule(
    impl = _web_toolchain_impl,
    attrs = {
        "native": attrs.exec_dep(providers = [RunInfo], default = "toolchains//web/native:web"),
        "driver": attrs.exec_dep(providers = [RunInfo], default = "toolchains//web:webc"),
        "svelte_runtime": attrs.exec_dep(providers = [SvelteRuntimeInfo], default = "toolchains//web/svelte:runtime"),
        # The default selects the standalone release for the execution platform.
        "tailwind_compiler": attrs.exec_dep(default = "toolchains//web/tailwind:compiler"),
        "tailwind_runner": attrs.exec_dep(providers = [RunInfo], default = "toolchains//web/tailwind:runner"),
    },
    is_toolchain_rule = True,
)

def web_toolchain_attr():
    return attrs.toolchain_dep(default = "toolchains//:web", providers = [WebToolchain])
