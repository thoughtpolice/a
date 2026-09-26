# SPDX-FileCopyrightText: 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@cellar//bootstrap:defs.bzl", "export_file")
load("@cellar//bootstrap/stage1:defs.bzl", "c_object", "link_runtime")
load(":defs.bzl", "gcc40_stage")

MUSL = "cellar//bootstrap/stage1/musl"

gcc40_stage(
    libgcc_extra_objects = [":tcc-libc-varargs.o"],
    musl = MUSL,
    musl_prefix = "gnu-",
    musl_runtime = MUSL + ":runtime-gnu",
    name_generated_outputs = False,
    object_flags = ["-Werror"],
    options_h_in_early_headers = False,
    predecessor = "cellar//bootstrap/stage1/tcc-native:tcc",
    runtime = "cellar//bootstrap/stage1/tcc-native:link-runtime",
    separate_runtime = ":link-runtime",
)

# What a program that this compiler links gets around its own objects.
link_runtime(
    name = "link-runtime",
    end_objects = [
        ":crtend.o",
        MUSL + ":gnu-crtn.o",
    ],
    libraries = [
        ":libgcc.a",
        MUSL + ":gnu-libc.a",
        ":libgcc.a",
        MUSL + ":gnu-libc.a",
    ],
    start_objects = [
        MUSL + ":gnu-crt1.o",
        MUSL + ":gnu-crti.o",
        ":crtbeginT.o",
    ],
)

[export_file(name = path) for path in glob([
    "patches/*.patch",
    "tests/*.c",
])]

export_file(name = "generators/ucnid.c")

# TCC built the input musl, which calls TCC's varargs helpers. libgcc carries
# a GCC-built copy of them.
c_object(
    name = "tcc-libc-varargs.o",
    src = "cellar//bootstrap/stage1/tcc-release:source[lib/va_list.c]",
    flags = [
        "-O2",
        "-Werror",
    ],
    object_name = "tccva.o",
    toolchain = ":bootstrap-gcc",
)
