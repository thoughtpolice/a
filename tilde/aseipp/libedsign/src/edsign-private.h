// SPDX-FileCopyrightText: © 2024-2025 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/*
** Public/private key generation.
** Copyright (C) 2014 Austin Seipp, Well-Typed LLP.
** See Copyright Notice in edsign.h
**
** Design mostly inspired by signify, written for OpenBSD.
** Copyright (C) 2013 Ted Unangst <tedu@openbsd.org>. See LICENSE.txt
*/

#ifndef _EDSIGN_PRIVATE_H_
#define _EDSIGN_PRIVATE_H_

#include <assert.h>
#include <stdbool.h>
#include <stdlib.h>
#include <stddef.h>
#include <stdint.h>
#include <string.h>
#include <errno.h>

#if defined(_WIN32) || defined(_WIN64) || defined(__TOS_WIN__) || defined(__WINDOWS__)
#include <windows.h>
#include <wincrypt.h>
#else
#include <sys/mman.h>
#include <sys/types.h>
#include <sys/stat.h>
#include <fcntl.h>
#include <unistd.h>
#endif /* !WINDOWS */

#include "libedsign/edsign.h"

/* -- OS support ------------------------------------------------------------ */

#if defined(__unix__) || defined(unix)
      #define OS_UNIX
#endif

#if defined(_WIN32) || defined(_WIN64) || defined(__TOS_WIN__) || defined(__WINDOWS__)
      #define OS_WINDOWS
#endif

/* -- Compiler support ------------------------------------------------------ */

#if defined(__GNUC__) && !defined(__clang__) && !defined(__ICC)
      #define COMPILER_GCC
#endif

#if defined(__clang__)
      #define COMPILER_CLANG __clang__
#endif

#if defined(__ICC)
      #define COMPILER_INTEL __ICC
#endif

#if defined(__COMPCERT__)
      #define COMPILER_COMPCERT
#endif

#if defined(__MINGW32__) || defined(__MINGW64__)
      #define COMPILER_MINGW
#endif

#if defined(_MSC_VER)
      #define COMPILER_MSVC
#endif

/* -- Architecture support -------------------------------------------------- */

/* x86/x86_64 */
#if defined(__amd64__) || defined(__amd64) || defined(__x86_64__ ) || defined(_M_X64)
      #define CPU_X86_64

#elif defined(__i586__) || defined(__i686__) || (defined(_M_IX86) && (_M_IX86 >= 500))
      #define CPU_X86 500

#elif defined(__i486__) || (defined(_M_IX86) && (_M_IX86 >= 400))
      #define CPU_X86 400

#elif defined(__i386__) || (defined(_M_IX86) && (_M_IX86 >= 300)) || defined(__X86__) || defined(_X86_) || defined(__I86__)
      #define CPU_X86 300

#elif defined(__ia64__) || defined(_IA64) || defined(__IA64__) || defined(_M_IA64) || defined(__ia64)
      #define CPU_IA64

#endif

/* PPC */

#if defined(powerpc) || defined(__PPC__) || defined(__ppc__) || defined(_ARCH_PPC) || defined(__powerpc__) || defined(__powerpc) || defined(POWERPC) || defined(_M_PPC)
      #define CPU_PPC
      #if defined(_ARCH_PWR7)
            #define CPU_POWER7
      #elif defined(__64BIT__)
            #define CPU_PPC64
      #else
            #define CPU_PPC32
      #endif
#endif

/* ARM */

#if defined(__arm__)
      #define CPU_ARM
#endif

/* SPARC */

#if defined(__sparc__) || defined(__sparc) || defined(__sparcv9)
      #define CPU_SPARC
      #if defined(__sparcv9)
            #define CPU_SPARC64
      #else
            #define CPU_SPARC32
      #endif
#endif

/* -------------------------------------------------------------------------- */
/* -- Macros ---------------------------------------------------------------- */

#define EDSIGN_EXPORT __attribute__ ((visibility("default")))

#if !defined(COMPILER_COMPCERT)
#define likely(x)   __builtin_expect((x),1)
#define unlikely(x) __builtin_expect((x),0)
#else
#define likely(x)   (x)
#define unlikely(x) (x)
#endif

#define FORCE_INLINE     __attribute__((always_inline))
#define UNUSED           __attribute__((unused))
#define PRINTF_ATTR(x,y) __attribute__((format(printf, x, y)))

#ifndef CTASSERT
#define CTASSERT(x)             _CTASSERT(x, __LINE__)
#define _CTASSERT(x, y)         __CTASSERT(x, y)
#define __CTASSERT(x, y)        typedef char __assert ## y[(x) ? 1 : -1]
#endif

#if defined(EDSIGN_AMALGAMATION)
#define EDSIGN_STATIC static
#else
#define EDSIGN_STATIC
#endif /* !EDSIGN_AMALGAMATIONI */

#endif /* !_EDSIGN_GENKEY_H_ */
