# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

"""Compile CSS with the pinned upstream Tailwind standalone compiler.

The entry must disable automatic discovery with `source(none)`. `srcs` supplies
candidate files; `css_srcs` supplies relative CSS imports. File-based `@source`
directives may only name individual declared candidates, while inline sources
retain upstream semantics. JavaScript plugins/configs and external imports are
not inputs of this rule and are rejected.
"""

def _css_impl(ctx: AnalysisContext) -> list[Provider]:
    sources = [ctx.attrs.src] + ctx.attrs.css_srcs + ctx.attrs.srcs
    manifest = ctx.actions.write_json("tailwind-inputs.json", {
        "entry": {"name": ctx.attrs.src.short_path, "path": ctx.attrs.src},
        "css": [{"name": src.short_path, "path": src} for src in ctx.attrs.css_srcs],
        "candidates": [{"name": src.short_path, "path": src} for src in ctx.attrs.srcs],
    })
    output = ctx.actions.declare_output(ctx.label.name + ".css")
    ctx.actions.run(
        cmd_args(
            ctx.attrs._runner[RunInfo],
            "--compiler",
            ctx.attrs._compiler[DefaultInfo].default_outputs[0],
            "--manifest",
            manifest,
            "--output",
            output.as_output(),
            ["--minify"] if ctx.attrs.minify else [],
            hidden = sources,
        ),
        category = "tailwind_css",
    )
    return [DefaultInfo(default_output = output)]

_css = rule(
    impl = _css_impl,
    attrs = {
        "src": attrs.source(),
        "srcs": attrs.list(attrs.source(), default = []),
        "css_srcs": attrs.list(attrs.source(), default = []),
        "minify": attrs.bool(default = False),
        # These dependencies are configured for the platform running the action,
        # not the platform the browser application is being built for.
        "_compiler": attrs.exec_dep(default = "toolchains//tailwind:compiler"),
        "_runner": attrs.exec_dep(providers = [RunInfo], default = "toolchains//tailwind:runner"),
    },
)

tailwind = struct(css = _css)
