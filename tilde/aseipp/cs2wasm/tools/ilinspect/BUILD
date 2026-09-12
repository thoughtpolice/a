# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:shims.bzl", depot = "shims")

# Prints an assembly's references, types, member references or methods' IL
# (README.md): `buck2 run :ilinspect -- <assembly> [mode]`.
depot.csharp.binary(
    name = "ilinspect",
    srcs = ["Main.cs"],
    implicit_usings = True,
    invariant_globalization = True,
    lang_version = "14.0",
    nullable = "disable",
)
