# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:shims.bzl", depot = "shims")

# Measures how much of the real BCL's IL could be imported onto Wasm GC
# (README.md): `buck2 run :bclscan -- <framework dir> <out.md>`.
depot.csharp.binary(
    name = "bclscan",
    srcs = [
        "Analysis.cs",
        "Main.cs",
        "Scan.cs",
    ],
    implicit_usings = True,
    invariant_globalization = True,
    lang_version = "14.0",
    nullable = "disable",
)

# Probe assemblies for runtime-async: the same source with the toolchain's
# default flags and with the Roslyn feature flag switched on.
depot.csharp.library(
    name = "asyncprobe_default",
    srcs = ["AsyncProbe.cs"],
    implicit_usings = True,
    lang_version = "preview",
)

depot.csharp.library(
    name = "asyncprobe_runtime_async",
    srcs = ["AsyncProbe.cs"],
    csc_flags = ["/features:runtime-async=on"],
    implicit_usings = True,
    lang_version = "preview",
)
