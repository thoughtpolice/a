# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:shims.bzl", "shims")

# How a csharp_binary is made runnable. The root PACKAGE aliases each value
# as a modifier, so `-m aot` selects it for a whole build; a target can pin
# one with `profile = "..."` regardless. Libraries are IL under every
# profile, so switching it only rebuilds binaries.
shims.constraint(
    name = "profile",
    default = "jit",
    values = [
        # tiered JIT, dynamic PGO off
        "jit",
        # tiered JIT with dynamic PGO
        "pgojit",
        # ReadyToRun precompiled assemblies (crossgen2)
        "r2r",
        # one native executable (ILCompiler)
        "aot",
    ],
)
