/*
** prelude.h: Common functions and macro definitions
**
** SPDX-FileCopyrightText: © 2016-2026 Austin Seipp
** SPDX-License-Identifier: BSD-3-Clause
*/
#ifndef _CHEZ_PRELUDE_H_
#define _CHEZ_PRELUDE_H_

#ifdef __cplusplus
extern "C" {
#endif

/* -------------------------------------------------------------------------- */
/* -- Top-level macros and definitions -------------------------------------- */

/* ---------------------- */
/* -- Operating System -- */
#if defined(__APPLE__)
#define PLATFORM_UNIX
#define PLATFORM_DARWIN
#define PLATFORM_STRING "Darwin"

#elif defined(__linux__)
#define PLATFORM_UNIX
#define PLATFORM_LINUX
#define PLATFORM_STRING "Linux"

#elif defined(_WIN32) || defined(_WIN64)
#define PLATFORM_WINDOWS
#define PLATFORM_STRING "Windows"

#elif defined(__unix__) || defined(unix)
#define PLATFORM_UNIX
#define PLATFORM_STRING "Unix"

#else
#define PLATFORM_UNKNOWN
#define PLATFORM_STRING "Unknown"
#endif

/* -------------- */
/* -- Compiler -- */

#if defined(__GNUC__) && !defined(__clang__) && !defined(__INTEL_COMPILER)

#if defined(__MINGW32__) || defined(__MINGW64__)
#define COMPILER_MINGW
#define COMPILER_STRING "gcc/mingw"
#define COMPILER_STRING "gcc/mingw " __VERSION__
#else
#define COMPILER_GNUC
#define COMPILER_NAME   "GCC"
#define COMPILER_STRING "GCC " __VERSION__
#endif

#elif  defined(_MSC_VER)                        // MSVC

#define __xstr(a) __str(a)
#define __str(a) #a

#if defined(__c2__)
#define COMPILER_CLANG
#define COMPILER_CLANG_C2
#define COMPILER_MSVC
#define COMPILER_NAME   "Clang/C2"
#define COMPILER_STRING "Clang/C2" __xstr(_MSC_VER)
#elif defined(__llvm__)
#define COMPILER_CLANG
#define COMPILER_LLVM
#define COMPILER_MSVC
#define COMPILER_NAME   "Clang/MSVC"
#define COMPILER_STRING "Clang/MSVC " __VERSION__
#else
#define COMPILER_MSVC
#define COMPILER_NAME   "MSVC"
#define COMPILER_STRING "MSVC " __xstr(_MSC_VER)
#endif

#elif  defined(__clang__)                       // Clang
#define COMPILER_CLANG
#define COMPILER_LLVM
#define COMPILER_NAME   "clang"
#define COMPILER_STRING "clang " __VERSION__

#elif defined(__INTEL_COMPILER)
#define COMPILER_INTEL
#define COMPILER_NAME   "Intel"
#define COMPILER_STRING "Intel " # __INTEL_COMPILER

#elif defined(__COMPCERT__)
#define COMPILER_COMPCERT
#define COMPILER_NAME   "CompCert"
#define COMPILER_STRING "CompCert"

#else
#define COMPILER_UNKNOWN
#define COMPILER_NAME   "Unknown"
#define COMPILER_STRING "Unknown"
#endif

/* -------------------------- */
/* -- Architecture support -- */

#if __BYTE_ORDER__ == __ORDER_LITTLE_ENDIAN__
#define CPU_ENDIAN_LITTLE
#else
#define CPU_ENDIAN_BIG
#endif

/* x86/x86_64 */
#if defined(__amd64__) || defined(__amd64) || defined(__x86_64__) \
    || defined(_M_X64)
#define CPU_X86_64
#define CPU_STRING "amd64"

#elif defined(__i586__) || defined(__i686__) \
    || (defined(_M_IX86) && (_M_IX86 >= 500))
#define CPU_X86 500
#define CPU_STRING "i686"

#elif defined(__i486__) || (defined(_M_IX86) && (_M_IX86 >= 400))
#define CPU_X86 400
#define CPU_STRING "i486"

#elif defined(__i386__) || (defined(_M_IX86) && (_M_IX86 >= 300)) \
    || defined(__X86__) || defined(_X86_) || defined(__I86__)
#define CPU_X86 300
#define CPU_STRING "i386"

#elif defined(__ia64__) || defined(_IA64) || defined(__IA64__) \
    || defined(_M_IA64) || defined(__ia64)
#define CPU_IA64
#define CPU_STRING "ia64"

#endif

/* PowerPC */
#if defined(powerpc) || defined(__PPC__) || defined(__ppc__) \
    || defined(_ARCH_PPC) || defined(__powerpc__) || defined(__powerpc) \
    || defined(POWERPC) || defined(_M_PPC)
#define CPU_PPC
#if defined(_ARCH_PWR7)
#define CPU_POWER7
#define CPU_STRING "ppc64"
#elif defined(__64BIT__)
#define CPU_PPC64
#define CPU_STRING "ppc64"
#else
#define CPU_PPC32
#define CPU_STRING "ppc32"
#endif
#endif

/* ARM */
#if defined(__arm__)
#define CPU_ARM
#define CPU_STRING "arm"
#endif

/* SPARC */
#if defined(__sparc__) || defined(__sparc) || defined(__sparcv9)
#define CPU_SPARC
#if defined(__sparcv9)
#define CPU_SPARC64
#define CPU_STRING "sparc64"
#else
#define CPU_SPARC32
#define CPU_STRING "sparc32"
#endif
#endif

/* -------------- */
/* -- Features -- */

/* Clang feature-checking macros */
#ifndef __has_feature
# define __has_feature(x) 0
#endif
#ifndef __has_extension
# define __has_extension __has_feature
#endif
#ifndef __has_attribute
# define __has_attribute(x) 0
#endif

/* --------------------- */
/* -- Basic utilities -- */

#if defined(COMPILER_GNUC) || defined(COMPILER_CLANG)
#define NO_INLINE    __attribute__((noinline))
#define INLINE_ME    __inline__ __attribute__((always_inline))
#define DEPRECATED   __attribute__((deprecated))
#define NOTNULL(...) __attribute__((nonnull(__VA_ARGS__)))
#define NORETURN     __attribute__((noreturn))
#define UNUSED       __attribute__((unused))
#define USED         __attribute__((__used__))
#define PRINTF_FORMAT(...) __attribute__((format (printf, __VA_ARGS__)))
#define MUST_CHECK   __attribute__((warn_unused_result))
#define PACKED       __attribute__((packed))
#define ALIGN(x)     __attribute__((aligned(x)))
#define likely(x)    __builtin_expect(!!(x),1)
#define unlikely(x)  __builtin_expect(!!(x),0)
#define cache_prefetch(...)  __builtin_prefetch(__VA_ARGS__)
#define HOT_FUNC  __attribute__((hot))
#define COLD_FUNC __attribute__((cold))

#else
#define NO_INLINE
#define INLINE_ME
#define DEPRECATED
#define NOTNULL(...)
#define NORETURN
#define UNUSED
#define USED
#define PRINTF_FORMAT(...)
#define MUST_CHECK
#define PACKED
#define ALIGN(x)
#define likely(x) (x)
#define unlikely(x) (x)
#define cache_prefetch(...)
#define HOT_FUNC
#define COLD_FUNC
#endif /* defined(COMPILER_GNUC) || defined(COMPILER_CLANG) */

/* ------------------- */
/* -- Miscellaneous -- */

#if defined(COMPILER_CLANG) && defined(COMPILER_LLVM)
#define XRAY_ALWAYS_INSTRUMENT __attribute__((xray_always_instrument))
#define XRAY_NEVER_INSTRUMENT  __attribute__((xray_never_instrument))
#else
#define XRAY_ALWAYS_INSTRUMENT
#define XRAY_NEVER_INSTRUMENT
#endif

#define countof(a) (sizeof(a)/sizeof(*(a)))
#define ROUND_TO_CACHE_LINE(x) \
  ((((x)+(KS_CACHE_SIZE-1)) / KSCACHE_SIZE) * KS_CACHE_SIZE)
#define PACK_CACHELINE PACKED ALIGN(KS_CACHE_SIZE)

/* ---------------------------- */
/* -- Thread safety analysis -- */

#if defined(COMPILER_CLANG)
#define THREAD_ANNOTATION_ATTRIBUTE__(x) __attribute__((x))
#else
#define THREAD_ANNOTATION_ATTRIBUTE__(x) // no-op
#endif

#define CAPABILITY(x) \
  THREAD_ANNOTATION_ATTRIBUTE__(capability(x))

#define SCOPED_CAPABILITY \
  THREAD_ANNOTATION_ATTRIBUTE__(scoped_lockable)

#define GUARDED_BY(x) \
  THREAD_ANNOTATION_ATTRIBUTE__(guarded_by(x))

#define PT_GUARDED_BY(x) \
  THREAD_ANNOTATION_ATTRIBUTE__(pt_guarded_by(x))

#define ACQUIRED_BEFORE(...) \
  THREAD_ANNOTATION_ATTRIBUTE__(acquired_before(__VA_ARGS__))

#define ACQUIRED_AFTER(...) \
  THREAD_ANNOTATION_ATTRIBUTE__(acquired_after(__VA_ARGS__))

#define REQUIRES(...) \
  THREAD_ANNOTATION_ATTRIBUTE__(requires_capability(__VA_ARGS__))

#define REQUIRES_SHARED(...) \
  THREAD_ANNOTATION_ATTRIBUTE__(requires_shared_capability(__VA_ARGS__))

#define ACQUIRE(...) \
  THREAD_ANNOTATION_ATTRIBUTE__(acquire_capability(__VA_ARGS__))

#define ACQUIRE_SHARED(...) \
  THREAD_ANNOTATION_ATTRIBUTE__(acquire_shared_capability(__VA_ARGS__))

#define RELEASE(...) \
  THREAD_ANNOTATION_ATTRIBUTE__(release_capability(__VA_ARGS__))

#define RELEASE_SHARED(...) \
  THREAD_ANNOTATION_ATTRIBUTE__(release_shared_capability(__VA_ARGS__))

#define TRY_ACQUIRE(...) \
  THREAD_ANNOTATION_ATTRIBUTE__(try_acquire_capability(__VA_ARGS__))

#define TRY_ACQUIRE_SHARED(...) \
  THREAD_ANNOTATION_ATTRIBUTE__(try_acquire_shared_capability(__VA_ARGS__))

#define EXCLUDES(...) \
  THREAD_ANNOTATION_ATTRIBUTE__(locks_excluded(__VA_ARGS__))

#define ASSERT_CAPABILITY(x) \
  THREAD_ANNOTATION_ATTRIBUTE__(assert_capability(x))

#define ASSERT_SHARED_CAPABILITY(x) \
  THREAD_ANNOTATION_ATTRIBUTE__(assert_shared_capability(x))

#define RETURN_CAPABILITY(x) \
  THREAD_ANNOTATION_ATTRIBUTE__(lock_returned(x))

#define NO_THREAD_SAFETY_ANALYSIS \
  THREAD_ANNOTATION_ATTRIBUTE__(no_thread_safety_analysis)

#ifdef __cplusplus
} /* extern "C" */
#endif

#endif /* _UTIL_PRELUDE_H_ */

/*
** Local Variables:
** mode: c
** fill-column: 80
** indent-tabs-mode: nil
** c-basic-offset: 2
** buffer-file-coding-system: utf-8-unix
** End:
*/
