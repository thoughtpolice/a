# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@cellar//bootstrap:actions.bzl", "command_test")
load("@cellar//bootstrap/stage1:defs.bzl", "bootstrap_artifact", "c_binary", "c_library", "c_object", "compiler")

compiler(
    name = "mescc",
    abi = "x86_64-mes",
    archive_format = "mes-concat",
    archiver = "cellar//bootstrap/stage0-posix/mescc-tools-extra:catm",
    cflags = [
        "-nostdinc",
        "-I",
        "$(location cellar//bootstrap/mes:mes-src[include])",
    ],
    compiler = "cellar//bootstrap/mes:mescc",
    family = "mescc",
    ldflags = ["-nostdlib"],
    object_format = "mes",
    stage = "mes-s3",
)

[
    bootstrap_artifact(
        name = name,
        src = src,
        abi = "x86_64-mes",
        kind = kind,
        object_format = "mes",
    )
    for name, src, kind in [
        ("crt", "cellar//bootstrap/mes:s3-crt1[crt1.o]", "object"),
        ("libc", "cellar//bootstrap/mes:s3-libc.a", "library"),
        ("libmescc", "cellar//bootstrap/mes:s3-libmescc.a", "library"),
    ]
]

c_object(
    name = "main.o",
    src = "main.c",
    object_name = "main.o",
    toolchain = ":mescc",
)

c_object(
    name = "answer.o",
    src = "answer.c",
    object_name = "answer.o",
    toolchain = ":mescc",
)

c_library(
    name = "answer.a",
    objects = [":answer.o"],
    output = "answer.a",
    toolchain = ":mescc",
)

c_binary(
    name = "separate-compilation",
    libraries = [
        ":answer.a",
        ":libc",
        ":libmescc",
    ],
    objects = [
        ":crt",
        ":main.o",
    ],
    toolchain = ":mescc",
)

command_test(
    name = "mescc-runinfo",
    tool = ":separate-compilation",
)
