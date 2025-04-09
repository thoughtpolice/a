# SPDX-FileCopyrightText: © 2024-2025 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims/shims.bzl", "shims")

def _ncc_bundle_impl(ctx: AnalysisContext) -> list[Provider]:
    source_dir = ctx.actions.copied_dir(
        "srcs",
        { src.short_path: src for src in ctx.attrs.srcs },
    )

    outdir = ctx.actions.declare_output("dist", dir = True)
    args = cmd_args(
        [
            cmd_args(["cd", source_dir, ";"]),
            cmd_args(["npm", "install", "&&"]),
            cmd_args(
                [
                    "npx", "ncc",
                    "build", "-m",
                    "src/extension.ts",
                    "-o", outdir.as_output(),
                ],
                relative_to = source_dir,
            ),
        ],
        delimiter = " ",
    )
    ctx.actions.run(
        cmd_args(
            [
                "/usr/bin/env",
                "bash",
                "-c",
                args,
            ],
        ),
        category = "ncc_bundle"
    )

    return [
        DefaultInfo(default_output = outdir.project("index.js")),
    ]

ncc_bundle = rule(
    impl = _ncc_bundle_impl,
    attrs = {
        "srcs": attrs.list(attrs.source()),
    }
)
