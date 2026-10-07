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
