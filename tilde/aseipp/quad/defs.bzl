# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

"""Standalone quad executables with Scheme code compiled in, and the GUI's
shaders.

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

def slang_shader(name: str, src: str, entry: str, stage: str):
    """`:<name>`, a file of SPIR-V for Vulkan 1.3 from the entry point
    `entry` (a `stage` shader) of the Slang source `src`, checked by
    spirv-val."""
    shims.genrule(
        name = name,
        srcs = [src],
        out = name,
        cmd = " && ".join([
            " ".join([
                "$(exe third-party//by-name/sl/slang:slangc)",
                "$SRCDIR/" + src,
                "-target spirv -profile spirv_1_6 -emit-spirv-directly -fvk-use-entrypoint-name",
                "-entry {} -stage {}".format(entry, stage),
                "-o $OUT",
            ]),
            "$(exe third-party//by-name/sp/spirv-tools:spirv-val) --target-env vulkan1.3 $OUT",
        ]),
    )
