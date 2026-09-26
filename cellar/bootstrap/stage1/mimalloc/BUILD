# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@cellar//bootstrap:actions.bzl", "command_test", "generate")
load("@cellar//bootstrap:defs.bzl", "export_file")
load("@cellar//bootstrap:source.bzl", "download_file", "untar")
load("@cellar//bootstrap/stage1:defs.bzl", "c_binary", "c_object")
load(":defs.bzl", "mimalloc_object")

GCC = "cellar//bootstrap/stage1/gcc10"

download_file(
    name = "mimalloc-3.5.3.tar.gz",
    hash = "3b4a15153a59905995f7070296ed604bb5ccc00cabb8b93446931aff77224d47",
    size_bytes = 1455942,
    urls = ["https://github.com/microsoft/mimalloc/archive/refs/tags/v3.5.3.tar.gz"],
)

generate(
    name = "mimalloc.tar",
    args = [
        "-dc",
        "$(location :mimalloc-3.5.3.tar.gz)",
    ],
    capture = True,
    tool = "cellar//bootstrap/stage1/gzip:gzip",
)

untar(
    name = "mimalloc-3.5.3",
    files = [
        "LICENSE",
        "include",
        "src/static.c",
    ],
    flags = ["-xf"],
    input = ":mimalloc.tar",
    untar = "cellar//bootstrap/stage1/pax:untar",
)

mimalloc_object(
    name = "mimalloc.o",
    toolchain = GCC + ":stage3-gcc",
)

export_file(name = "tests/override.c")

c_object(
    name = "override.o",
    src = ":tests/override.c",
    flags = [
        "-std=gnu11",
        "-O2",
    ],
    headers = [":mimalloc-3.5.3[include]"],
    includes = [":mimalloc-3.5.3[include]"],
    toolchain = GCC + ":stage3-gcc",
)

c_binary(
    name = "override",
    objects = [
        ":override.o",
        ":mimalloc.o",
    ],
    runtime = GCC + ":stage3-link-runtime",
    toolchain = GCC + ":stage3-gcc",
)

command_test(
    name = "override-test",
    tool = ":override",
)
