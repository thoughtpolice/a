# SPDX-FileCopyrightText: 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

# Second GCC 4.0.4 build: predecessor GCC plus full musl 1.2.5.
# Shared handwritten patches/inventories remain in gcc40; each generator and
# compiler action below belongs to this new stage.

load("@cellar//bootstrap/stage1/gcc40:defs.bzl", "gcc40_stage")

MUSL = "cellar//bootstrap/stage1/musl12"

gcc40_stage(
    crt = [
        MUSL + ":crt1.o",
        MUSL + ":crti.o",
        "cellar//bootstrap/stage1/gcc40:crtbeginT.o",
    ],
    crtn = [
        "cellar//bootstrap/stage1/gcc40:crtend.o",
        MUSL + ":crtn.o",
    ],
    libc = [
        MUSL + ":libc.a",
        "cellar//bootstrap/stage1/gcc40:libgcc.a",
        MUSL + ":libc.a",
    ],
    libgcc_extra_objects = [],
    local_sources = False,
    musl = MUSL,
    musl_prefix = "",
    musl_runtime = MUSL + ":runtime",
    name_generated_outputs = True,
    object_flags = [
        "-O2",
        "-Werror",
    ],
    options_h_in_early_headers = True,
    predecessor = "cellar//bootstrap/stage1/musl12:gcc",
    separate_crtbegin = [],
    separate_crtend = [],
    stage = "gcc-4.0.4-musl-rebuilt",
)
