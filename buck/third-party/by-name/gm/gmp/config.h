/* SPDX-FileCopyrightText: 1996-2022 Free Software Foundation, Inc.
   SPDX-FileCopyrightText: © 2026 Austin Seipp
   SPDX-License-Identifier: LGPL-3.0-or-later OR GPL-2.0-or-later */

/* config.h for GMP 6.3.0, written by hand from config.in in place of running
   configure. It describes what `configure --disable-assembly --enable-cxx`
   finds on a 64-bit little-endian Linux (glibc) or macOS host; x86_64 and
   arm64 answer every check the same way once the assembler is out of the
   picture, which is also why no HAVE_HOST_CPU_* or HAVE_NATIVE_mpn_* entry
   appears here. Defines configure would leave undefined are left out.

   The table generators and mpn sources are run with GMP_LIMB_BITS 64 by the
   BUILD file next to this one, so a target where that does not hold is
   rejected here rather than miscompiled. */

#ifndef GMP_DEPOT_CONFIG_H
#define GMP_DEPOT_CONFIG_H

#if !defined(__LP64__) || !defined(__ORDER_LITTLE_ENDIAN__) || __BYTE_ORDER__ != __ORDER_LITTLE_ENDIAN__
#error "this GMP configuration is for 64-bit little-endian (LP64) targets only"
#endif

/* --disable-assembly: generic C mpn, and no inline assembly in longlong.h. */
#define NO_ASM 1

/* --enable-fft (the default) */
#define WANT_FFT 1

/* --enable-alloca=reentrant (the default), with a working alloca */
#define WANT_TMP_ALLOCA 1

/* What the tune program would suggest updating; this build has no tuning. */
#define GMP_MPARAM_H_SUGGEST "./mpn/generic/gmp-mparam.h"
#define TUNE_SQR_TOOM2_MAX SQR_TOOM2_MAX_GENERIC

/* Package identification, from AC_INIT. */
#define PACKAGE "gmp"
#define PACKAGE_BUGREPORT "gmp-bugs@gmplib.org (see https://gmplib.org/manual/Reporting-Bugs.html)"
#define PACKAGE_NAME "GNU MP"
#define PACKAGE_STRING "GNU MP 6.3.0"
#define PACKAGE_TARNAME "gmp"
#define PACKAGE_URL "http://www.gnu.org/software/gmp/"
#define PACKAGE_VERSION "6.3.0"
#define VERSION "6.3.0"
#define LT_OBJDIR ".libs/"

/* Compiler features (clang and gcc both accept these). */
#define HAVE_ATTRIBUTE_CONST 1
#define HAVE_ATTRIBUTE_MALLOC 1
#define HAVE_ATTRIBUTE_MODE 1
#define HAVE_ATTRIBUTE_NORETURN 1

/* Data representation. */
#define HAVE_DOUBLE_IEEE_LITTLE_ENDIAN 1
#define HAVE_LIMB_LITTLE_ENDIAN 1
#define SIZEOF_MP_LIMB_T 8
#define SIZEOF_UNSIGNED 4
#define SIZEOF_UNSIGNED_LONG 8
#define SIZEOF_UNSIGNED_SHORT 2
#define SIZEOF_VOID_P 8

/* Types. */
#define HAVE_INTMAX_T 1
#define HAVE_INTPTR_T 1
#define HAVE_LONG_DOUBLE 1
#define HAVE_LONG_LONG 1
#define HAVE_PTRDIFF_T 1
#define HAVE_QUAD_T 1
#define HAVE_STACK_T 1
#define HAVE_UINT_LEAST32_T 1
#define RETSIGTYPE void

/* Headers. */
#define HAVE_ALLOCA 1
#define HAVE_ALLOCA_H 1
#define HAVE_DLFCN_H 1
#define HAVE_FCNTL_H 1
#define HAVE_FLOAT_H 1
#define HAVE_INTTYPES_H 1
#define HAVE_LANGINFO_H 1
#define HAVE_LOCALE_H 1
#define HAVE_MEMORY_H 1
#define HAVE_NL_TYPES_H 1
#define HAVE_STDINT_H 1
#define HAVE_STDLIB_H 1
#define HAVE_STRINGS_H 1
#define HAVE_STRING_H 1
#define HAVE_SYS_MMAN_H 1
#define HAVE_SYS_PARAM_H 1
#define HAVE_SYS_RESOURCE_H 1
#define HAVE_SYS_STAT_H 1
#define HAVE_SYS_TIMES_H 1
#define HAVE_SYS_TIME_H 1
#define HAVE_SYS_TYPES_H 1
#define HAVE_UNISTD_H 1
#define STDC_HEADERS 1
#define TIME_WITH_SYS_TIME 1

/* Declarations. */
#define HAVE_DECL_FGETC 1
#define HAVE_DECL_FSCANF 1
#define HAVE_DECL_OPTARG 1
#define HAVE_DECL_UNGETC 1
#define HAVE_DECL_VFPRINTF 1

/* Functions. */
#define HAVE_ALARM 1
#define HAVE_CLOCK 1
#define HAVE_CLOCK_GETTIME 1
#define HAVE_GETPAGESIZE 1
#define HAVE_GETRUSAGE 1
#define HAVE_GETTIMEOFDAY 1
#define HAVE_LOCALECONV 1
#define HAVE_MEMSET 1
#define HAVE_MMAP 1
#define HAVE_MPROTECT 1
#define HAVE_NL_LANGINFO 1
#define HAVE_POPEN 1
#define HAVE_RAISE 1
#define HAVE_SIGACTION 1
#define HAVE_SIGALTSTACK 1
#define HAVE_STRCHR 1
#define HAVE_STRERROR 1
#define HAVE_STRNLEN 1
#define HAVE_STRTOL 1
#define HAVE_STRTOUL 1
#define HAVE_SYSCONF 1
#define HAVE_TIMES 1
#define HAVE_VSNPRINTF 1

/* C++ (--enable-cxx), for gmpxx and its tests. */
#define HAVE_SSTREAM 1
#define HAVE_STD__LOCALE 1

/* What differs between the two C libraries. */
#if defined(__linux__)
/* glibc */
#define HAVE_DECL_SYS_ERRLIST 0
#define HAVE_DECL_SYS_NERR 0
#define HAVE_HIDDEN_ALIAS 1
#define HAVE_OBSTACK_VPRINTF 1
#define HAVE_SYS_SYSINFO_H 1
#elif defined(__APPLE__)
#define HAVE_DECL_SYS_ERRLIST 1
#define HAVE_DECL_SYS_NERR 1
#define HAVE_SYSCTL 1
#define HAVE_SYSCTLBYNAME 1
#define HAVE_SYS_SYSCTL_H 1
#else
#error "this GMP configuration covers Linux and macOS only"
#endif

#endif /* GMP_DEPOT_CONFIG_H */
