# SPDX-FileCopyrightText: 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

# GCC 4.0.4 again, built by the first GCC 4.0.4 against musl 1.2.5.

load("@cellar//bootstrap/stage1:defs.bzl", "link_runtime")
load("@cellar//bootstrap/stage1/gcc40:defs.bzl", "gcc40_stage")

GCC40 = "cellar//bootstrap/stage1/gcc40"

MUSL = "cellar//bootstrap/stage1/musl12"

gcc40_stage(
    libgcc_extra_objects = [],
    musl = MUSL,
    musl_prefix = "",
    musl_runtime = MUSL + ":runtime",
    name_generated_outputs = True,
    object_flags = [
        "-O2",
        "-Werror",
    ],
    options_h_in_early_headers = True,
    predecessor = MUSL + ":gcc",
    runtime = MUSL + ":gcc-link-runtime",
    separate_runtime = ":separate-link-runtime",
)

# What a program that this compiler links gets around its own objects.
link_runtime(
    name = "link-runtime",
    end_objects = [
        ":crtend.o",
        MUSL + ":crtn.o",
    ],
    libraries = [
        MUSL + ":libc.a",
        ":libgcc.a",
        MUSL + ":libc.a",
    ],
    start_objects = [
        MUSL + ":crt1.o",
        MUSL + ":crti.o",
        ":crtbeginT.o",
    ],
)

# The separate-archive test links this build's libgcc.a between the first
# GCC 4.0.4's crtbeginT.o and crtend.o.
link_runtime(
    name = "separate-link-runtime",
    end_objects = [
        GCC40 + ":crtend.o",
        MUSL + ":crtn.o",
    ],
    libraries = [
        ":libgcc.a",
        MUSL + ":libc.a",
        ":libgcc.a",
        MUSL + ":libc.a",
    ],
    start_objects = [
        MUSL + ":crt1.o",
        MUSL + ":crti.o",
        GCC40 + ":crtbeginT.o",
    ],
)
