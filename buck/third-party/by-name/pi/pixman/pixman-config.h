/*
 * SPDX-FileCopyrightText: © 2018 Intel Corporation
 * SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
 * SPDX-License-Identifier: MIT
 *
 * The configuration meson.build would write as pixman-config.h for clang
 * against glibc on x86_64 and aarch64 Linux. A new release's meson.build
 * may add a check; compare its config.set() calls against this list.
 */

#ifndef PIXMAN_CONFIG_H
#define PIXMAN_CONFIG_H

/* Required by pixman-private.h; the value is not otherwise used. */
#define PACKAGE "foo"

#define HAVE_PTHREADS 1
#define HAVE_SIGACTION 1
#define HAVE_ALARM 1
#define HAVE_MPROTECT 1
#define HAVE_GETPAGESIZE 1
#define HAVE_MMAP 1
#define HAVE_GETTIMEOFDAY 1
#define HAVE_POSIX_MEMALIGN 1
#define HAVE_FEENABLEEXCEPT 1
#define HAVE_FEDIVBYZERO 1
#define HAVE_SYS_MMAN_H 1
#define HAVE_FENV_H 1
#define HAVE_UNISTD_H 1
#define HAVE_BUILTIN_CLZ 1
#define HAVE_GCC_VECTOR_EXTENSIONS 1

#define TLS __thread
#define TOOLCHAIN_SUPPORTS_ATTRIBUTE_CONSTRUCTOR 1
#define TOOLCHAIN_SUPPORTS_ATTRIBUTE_DESTRUCTOR 1
#define USE_GCC_INLINE_ASM 1

#define SIZEOF_LONG 8

/*
 * Clang's integrated assembler rejects .func and, outside 32-bit ARM,
 * .syntax unified, and ELF symbols take no leading underscore, so
 * ASM_HAVE_FUNC_DIRECTIVE, ASM_HAVE_SYNTAX_UNIFIED and ASM_LEADING_UNDERSCORE
 * stay undefined.
 */

/*
 * meson.build turns MMX and SSE2 on for every x86_64 compiler and SSSE3
 * for any that takes -mssse3; the A64 NEON assembly for every aarch64 one.
 * pixman-x86.c checks cpuid before it uses SSSE3.
 */
#if defined(__x86_64__)
#define HAVE_FLOAT128 1
#define USE_X86_MMX 1
#define USE_SSE2 1
#define USE_SSSE3 1
#elif defined(__aarch64__)
#define USE_ARM_A64_NEON 1
#else
#error "pixman-config.h describes only x86_64 and aarch64"
#endif

#endif /* PIXMAN_CONFIG_H */
