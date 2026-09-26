<!-- SPDX-FileCopyrightText: 2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# mimalloc 3.5.3

`mimalloc_object` in `defs.bzl` compiles mimalloc's single-file build,
`src/static.c`, into one object with `MI_MALLOC_OVERRIDE`, so it defines
`malloc` and the rest of the C allocation interface, which musl lets a
static program replace. A program links it ahead of musl's C library.

musl's allocator returns memory to the kernel eagerly. Compiling one large
C++ source with GCC 13 makes about 360,000 `munmap` and as many `mmap`
calls. With mimalloc, GCC 13's second and third stages compile about 15%
faster, with identical output. GCC 13 compiles one object per stage with
that stage's host compiler; `mimalloc.o` here is compiled by the final GCC
10.5 stage.

`override-test` links a program with `mimalloc.o` and checks that `malloc`,
`realloc` and `calloc` return memory from mimalloc's heap, on the main thread
and on another.
