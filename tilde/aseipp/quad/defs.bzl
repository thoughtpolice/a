# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

"""Standalone quad executables with Scheme code compiled in.

quad is a kernel with boot files appended to it (kernel/kernel.c, and
embed.sls in the Chez toolchain). `quad --build-exe OUT FILE...` writes a copy of itself
with one more boot file, compiled from FILEs, whose code runs as the editor
boots: that is how a configured editor becomes a single binary to hand out.
"""

load("@root//buck/shims:shims.bzl", "shims")

def quad_executable(name: str, srcs: list[str], quad: str = "depot-tilde//aseipp/quad:quad", **kwargs):
    """`:<name>`, a standalone quad with `srcs` compiled in, in order.

    Each source is Scheme top-level code with all of quad in scope, like an
    init file: it can define commands, bind keys and set variables.
    """
    shims.genrule(
        name = name,
        out = name,
        srcs = srcs,
        cmd = "$(exe {}) --build-exe $OUT {}".format(quad, " ".join(srcs)),
        executable = True,
        **kwargs
    )
