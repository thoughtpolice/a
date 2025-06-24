# SPDX-FileCopyrightText: © 2024-2025 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@prelude//erlang:erlang_toolchain.bzl", "config_erlang_toolchain_rule", "multi_version_toolchain_rule")

native.erlang_otp_binaries(
    name = "local",
    erl = "local/erl",
    erlc = "local/erlc",
    escript = "local/escript",
)

config_erlang_toolchain_rule(
    name = "erlang-local",
    otp_binaries = ":local",
    visibility = ["PUBLIC"],
    erl_opts = "+nowarn_underscore_match +debug_info +warnings_as_errors -DA_MACRO",
    emu_flags = "+sbwt very_short +sbwtdcpu very_short +sbwtdio very_short",
    parse_transforms = [],
    parse_transforms_filters = {},
)

multi_version_toolchain_rule(
    name = "erlang",
    targets = [":erlang-local"],
    visibility = ["PUBLIC"],
)
