# SPDX-FileCopyrightText: 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@cellar//bootstrap/stage1:defs.bzl", "c_object")

# The directories the Makefile names with -I for every object: the build
# directory, which holds pyconfig.h, and the public and internal headers.
INCLUDES = [
    ".",
    "Include",
    "Include/internal",
    "Include/internal/mimalloc",
]

def python_object(path, toolchain, flags, defines = [], includes = [], logical_includes = [], extension = ".c"):
    """Compiles path, a source in :source without its extension, as the
    Makefile would, to the target path + ".o"."""
    c_object(
        name = path + ".o",
        src = ":source",
        defines = defines,
        flags = flags,
        includes = includes,
        logical_includes = INCLUDES + logical_includes,
        logical_source = path + extension,
        object_name = path.split("/")[-1] + ".o",
        source_alias = "cellar//bootstrap/stage1/tools:source-alias",
        source_tree = ":source",
        toolchain = toolchain,
    )
