# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

# The Chez Scheme toolchain: chez.library, chez.program, chez.boot and
# chez.standalone (defs.bzl), the Chez Scheme kernel to link programs with,
# and the loader standalone programs boot with.

load("@root//buck/shims:shims.bzl", "shims")
load(":defs.bzl", "chez", "chez_toolchain")

CHEZ = "third-party//by-name/ch/chez-scheme"

chez_toolchain(
    name = "chez",
    boot = "boot.ss",
    compile = "compile.ss",
    embed_sls = "embed.sls",
    pack = "pack.ss",
    petite_boot = CHEZ + ":install[petite.boot]",
    scheme = CHEZ + ":scheme",
    scheme_boot = CHEZ + ":install[scheme.boot]",
    visibility = ["PUBLIC"],
)

# Chez Scheme's C kernel, and scheme.h: what a program embedding Chez
# Scheme links.
shims.alias(
    name = "kernel",
    actual = CHEZ + ":kernel",
    visibility = ["PUBLIC"],
)

# Booting from boot files appended to the executable (chez_embed.h).
shims.cxx_library(
    name = "embed",
    srcs = ["embed.c"],
    compiler_flags = [
        "-std=gnu11",
        "-Wall",
        "-Wextra",
        "-O2",
    ],
    exported_headers = {"chez_embed.h": "chez_embed.h"},
    header_namespace = "",
    preferred_linkage = "static",
    visibility = ["PUBLIC"],
    deps = [":kernel"],
)

# (chez embed): reading and writing standalone executables from Scheme, so
# that programs can make new ones from themselves.
chez.library(
    name = "embed-scheme",
    srcs = {"chez/embed.sls": "embed.sls"},
    visibility = ["PUBLIC"],
)
