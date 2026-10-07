# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

SvelteRuntimeInfo = provider(
    doc = "Pinned Svelte runtime and declaration directories, never app dependencies.",
    fields = {"packages": provider_field(dict[str, Artifact])},
)

def _svelte_runtime_impl(ctx: AnalysisContext) -> list[Provider]:
    packages = {name: dep[DefaultInfo].default_outputs[0] for name, dep in ctx.attrs.packages.items()}
    manifest = ctx.actions.write_json("runtime.json", packages)
    return [
        DefaultInfo(default_output = manifest, other_outputs = packages.values()),
        SvelteRuntimeInfo(packages = packages),
    ]

svelte_runtime = rule(
    impl = _svelte_runtime_impl,
    attrs = {"packages": attrs.dict(attrs.string(), attrs.dep())},
)
