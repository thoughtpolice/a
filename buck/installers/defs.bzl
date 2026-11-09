# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

"""Rule for creating installable targets using buck2 install."""

def _installable_impl(ctx: AnalysisContext) -> list[Provider]:
    installer = ctx.attrs.installer
    providers = [
        InstallInfo(
            installer = installer,
            files = ctx.attrs.files,
        ),
    ]
    main = ctx.attrs.main
    if main == None:
        return providers + [DefaultInfo()]
    providers.append(main[DefaultInfo])
    if RunInfo in main:
        providers.append(main[RunInfo])
    return providers

installable = rule(
    impl = _installable_impl,
    attrs = {
        "files": attrs.dict(
            key = attrs.string(),
            value = attrs.source(),
            default = {},
        ),
        "installer": attrs.label(),
        "main": attrs.option(
            attrs.dep(),
            default = None,
            doc = "A target this one stands for otherwise: it builds its outputs and runs it, so that one name can be built, run and installed.",
        ),
    },
)
