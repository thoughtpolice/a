<!-- SPDX-FileCopyrightText: 2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# mimalloc 3.5.3

GCC 13's `cc1` and `cc1plus`, Clang, LLD and LLVM's TableGen programs link
`mimalloc.o` ahead of musl. It is mimalloc's single-file build, `src/static.c`,
compiled by the final GCC 10.5 stage with `MI_MALLOC_OVERRIDE`, so it defines
`malloc` and the rest of the C allocation interface, which musl lets a static
program replace.

musl's allocator returns memory to the kernel eagerly. Compiling one large
Clang source with GCC 13 makes about 360,000 `munmap` and as many `mmap`
calls. With mimalloc, GCC 13's second and third stages compile about 15%
faster, libstdc++ 13 about 13% and LLVM about 7%, with identical output: the
stage2 and stage3 objects still match.

`override-test` links a program with `mimalloc.o` and checks that `malloc`,
`realloc` and `calloc` return memory from mimalloc's heap, on the main thread
and on another.
