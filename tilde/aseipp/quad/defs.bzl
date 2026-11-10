# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

"""Standalone quad executables with Scheme code compiled in, and the GUI's
shaders: SPIR-V for Vulkan (Linux and Windows), Metal source for Metal
(macOS).

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

# The shader genrules run under bash, or cmd.exe on a Windows host, so their
# commands keep to what both read alike: programs and their arguments, $OUT
# and $SRCDIR (which the genrule spells %OUT% and %SRCDIR% for cmd.exe), and
# `&&`. Buck writes the paths of $(exe) with the host's separators.

def slang_metal(name: str, src: str, entries: list[(str, str)]):
    """`:<name>`, Metal Shading Language source of the entry points
    `entries` (each a name and its stage) of the Slang source `src`: one
    library, which Metal compiles when a program makes it (there is no
    Metal compiler at build time)."""
    shims.genrule(
        name = name,
        srcs = [src],
        out = name,
        cmd = " ".join([
            "$(exe third-party//by-name/sl/slang:slangc)",
            "$SRCDIR/" + src,
            "-target metal",
        ] + [
            "-entry {} -stage {}".format(entry, stage)
            for entry, stage in entries
        ] + [
            "-o $OUT",
        ]),
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
