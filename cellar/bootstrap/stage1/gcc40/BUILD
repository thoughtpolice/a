# SPDX-FileCopyrightText: 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@cellar//bootstrap:defs.bzl", "export_file")
load("@cellar//bootstrap/stage1:defs.bzl", "c_object")
load(":defs.bzl", "gcc40_stage")

MUSL = "cellar//bootstrap/stage1/musl"

gcc40_stage(
    crt = [
        MUSL + ":gnu-crt1.o",
        MUSL + ":gnu-crti.o",
    ],
    crtn = [MUSL + ":gnu-crtn.o"],
    libc = [
        MUSL + ":gnu-libc.a",
        "cellar//bootstrap/stage1/tcc-native:libtcc1.a",
        MUSL + ":gnu-libc.a",
    ],
    libgcc_extra_objects = [":tcc-libc-varargs.o"],
    local_sources = True,
    musl = MUSL,
    musl_prefix = "gnu-",
    musl_runtime = MUSL + ":runtime-gnu",
    name_generated_outputs = False,
    object_flags = ["-Werror"],
    options_h_in_early_headers = False,
    predecessor = "cellar//bootstrap/stage1/tcc-native:tcc",
    separate_crtbegin = [":crtbeginT.o"],
    separate_crtend = [":crtend.o"],
    stage = "gcc-4.0.4-TCC-built",
)

[export_file(name = path) for path in glob([
    "patches/*",
    "tests/*.c",
])]

export_file(name = "generators/ucnid.c")

# The input musl archive was built by TCC and still calls these SysV helpers.
# Recompile this small compatibility object with GCC; the next musl rebuild
# uses GCC builtins and no longer needs it.
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
