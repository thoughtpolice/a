# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

"""Rule for creating installable targets using buck2 install."""

def _installable_impl(ctx: AnalysisContext) -> list[Provider]:
    installer = ctx.attrs.installer
    return [
        DefaultInfo(),
        InstallInfo(
            installer = installer,
            files = ctx.attrs.files,
        ),
    ]

installable = rule(
    impl = _installable_impl,
    attrs = {
        "files": attrs.dict(
            key = attrs.string(),
            value = attrs.source(),
            default = {},
        ),
        "installer": attrs.label(),
    },
)
