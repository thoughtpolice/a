# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@cellar//bootstrap/stage1:defs.bzl", "c_object")

_SOURCE = "cellar//bootstrap/stage1/mimalloc:mimalloc-3.5.3"

def mimalloc_object(name, toolchain):
    """mimalloc as one object, compiled by toolchain.

    src/static.c includes the whole allocator. With MI_MALLOC_OVERRIDE, it
    defines malloc and the rest of the C allocation interface, which musl
    lets a static program replace.
    """
    c_object(
        name = name,
        src = _SOURCE + "[src/static.c]",
        defines = [
            "MI_MALLOC_OVERRIDE=1",
            "NDEBUG",
        ],
        flags = [
            "-std=gnu11",
            "-O2",
            "-fno-builtin-malloc",
        ],
        headers = [_SOURCE],
        includes = [_SOURCE + "[include]"],
        object_name = "mimalloc.o",
        toolchain = toolchain,
    )
