# SPDX-FileCopyrightText: © 2024-2025 Benjamin Brittain
# SPDX-License-Identifier: Apache-2.0

TarToolchainInfo = provider(
    fields = {
        "tar": typing.Any,
    },
)

def tar_toolchain_impl(ctx) -> list[[DefaultInfo, TarToolchainInfo]]:
    """
    A Tar toolchain.
    """
    return [
        DefaultInfo(),
        TarToolchainInfo(
            tar = ctx.attrs._tar,
        ),
    ]

tar_toolchain = rule(
    impl = tar_toolchain_impl,
    attrs = {
        "_tar": attrs.exec_dep(
            default = "//buck/lib/tar/helpers:tar",
        ),
    },
    is_toolchain_rule = True,
)
