/* SPDX-FileCopyrightText: © 1996-2026 Anthony Green, Red Hat, Inc and others */
/* SPDX-FileCopyrightText: © 2026 Austin Seipp */
/* SPDX-License-Identifier: MIT */

/* What configure writes from fficonfig.h.in for the targets this package
   builds, Linux and macOS on x86_64 and arm64 with clang, reduced to the
   macros the library and its tests read. Where configure's answer follows
   from the target, a predefined macro gives it, so one header serves every
   target. */

#ifndef LIBFFI_FFICONFIG_H
#define LIBFFI_FFICONFIG_H

#if !(defined(__linux__) || defined(__APPLE__)) || !(defined(__x86_64__) || defined(__aarch64__))
#error "fficonfig.h only describes Linux and macOS on x86_64 and arm64"
#endif

/* configure's default on Linux: a closure's trampoline is a read-only page
   of code mapped from the binary itself, rather than code written to memory
   that is also executable. */
#if defined(__linux__)
#define FFI_EXEC_STATIC_TRAMP 1
#endif

/* Apple arm64 cannot map PROT_EXEC memory, so closures come from a table of
   prebuilt trampolines. Other Apple targets map code through a temporary
   file. */
#if defined(__APPLE__) && defined(__aarch64__)
#define FFI_EXEC_TRAMPOLINE_TABLE 1
#elif defined(__APPLE__)
#define FFI_MMAP_EXEC_WRIT 1
#endif

/* configure's pointer authentication probe: true only for arm64e. */
#if defined(__clang__) && defined(__has_feature)
#if __has_feature(ptrauth_calls)
#define HAVE_ARM64E_PTRAUTH 1
#endif
#endif

#define HAVE_AS_CFI_PSEUDO_OP 1
#if defined(__x86_64__)
#define HAVE_AS_X86_PCREL 1
#if defined(__ELF__)
#define HAVE_AS_X86_64_UNWIND_SECTION_TYPE 1
#endif
#endif

#define HAVE_ALLOCA_H 1
#define HAVE_INTTYPES_H 1
#define HAVE_MEMCPY 1
#define HAVE_STDINT_H 1
#define STDC_HEADERS 1

/* glibc declares memfd_create in <sys/mman.h>; it has no <sys/memfd.h>. */
#if defined(__linux__)
#define HAVE_MEMFD_CREATE 1
#endif

#define HAVE_INT128 1

#if __BYTE_ORDER__ == __ORDER_BIG_ENDIAN__
#define WORDS_BIGENDIAN 1
#endif

#define HAVE_HIDDEN_VISIBILITY_ATTRIBUTE 1

#ifdef HAVE_HIDDEN_VISIBILITY_ATTRIBUTE
#ifdef LIBFFI_ASM
#ifdef __APPLE__
#define FFI_HIDDEN(name) .private_extern name
#else
#define FFI_HIDDEN(name) .hidden name
#endif
#else
#define FFI_HIDDEN __attribute__ ((visibility ("hidden")))
#endif
#else
#ifdef LIBFFI_ASM
#define FFI_HIDDEN(name)
#else
#define FFI_HIDDEN
#endif
#endif

#endif /* LIBFFI_FFICONFIG_H */
