# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

OciToolchainInfo = provider(
    doc = "OCI toolchain: the oci tool every rule here runs, and the patchelf native_binary_layer uses",
    fields = {
        "oci": provider_field(typing.Any, default = None),
        "patchelf": provider_field(typing.Any, default = None),
    },
)

def _oci_toolchain_impl(ctx) -> list[[DefaultInfo, OciToolchainInfo]]:
    return [
        DefaultInfo(),
        OciToolchainInfo(
            oci = ctx.attrs.oci,
            patchelf = ctx.attrs.patchelf,
        ),
    ]

oci_toolchain = rule(
    impl = _oci_toolchain_impl,
    attrs = {
        "oci": attrs.exec_dep(providers = [RunInfo]),
        "patchelf": attrs.exec_dep(providers = [RunInfo]),
    },
    is_toolchain_rule = True,
)
