/* SPDX-FileCopyrightText: 2016 WebAssembly Community Group participants
 * SPDX-License-Identifier: Apache-2.0
 */

/*
 * Copyright 2016 WebAssembly Community Group participants
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

#ifndef WABT_CONFIG_H_
#define WABT_CONFIG_H_

#include <stdarg.h>
#include <stdint.h>
#include <stdlib.h>

#define WABT_VERSION_STRING "1.0.41 (git~1.0.41-70-g4e145b34)"

#if defined(_WIN32)
#define HAVE_ALLOCA_H 0
#define HAVE_UNISTD_H 0
#define HAVE_SSIZE_T 0
#define HAVE_STRCASECMP 0
#define HAVE_WIN32_VT100 1
#else
#define HAVE_ALLOCA_H 1
#define HAVE_UNISTD_H 1
#define HAVE_SSIZE_T 1
#define HAVE_STRCASECMP 1
#define HAVE_WIN32_VT100 0
#endif

#define HAVE_SNPRINTF 1
#define HAVE_OPENSSL_SHA_H 0

#if defined(__clang__)
#define COMPILER_IS_CLANG 1
#define COMPILER_IS_GNU 0
#define COMPILER_IS_MSVC 0
#elif defined(_MSC_VER)
#define COMPILER_IS_CLANG 0
#define COMPILER_IS_GNU 0
#define COMPILER_IS_MSVC 1
#elif defined(__GNUC__)
#define COMPILER_IS_CLANG 0
#define COMPILER_IS_GNU 1
#define COMPILER_IS_MSVC 0
#else
#error unknown compiler
#endif

#define WITH_EXCEPTIONS 0

#if defined(__SIZEOF_SIZE_T__)
#define SIZEOF_SIZE_T __SIZEOF_SIZE_T__
#elif defined(_WIN64)
#define SIZEOF_SIZE_T 8
#else
#define SIZEOF_SIZE_T 4
#endif

#if defined(__BYTE_ORDER__) && defined(__ORDER_BIG_ENDIAN__) && \
    __BYTE_ORDER__ == __ORDER_BIG_ENDIAN__
#define WABT_BIG_ENDIAN 1
#else
#define WABT_BIG_ENDIAN 0
#endif

#if HAVE_ALLOCA_H
#include <alloca.h>
#elif COMPILER_IS_MSVC
#include <malloc.h>
#define alloca _alloca
#elif defined(__MINGW32__)
#include <malloc.h>
#endif

#if COMPILER_IS_CLANG || COMPILER_IS_GNU

#define WABT_UNLIKELY(x) __builtin_expect(!!(x), 0)
#define WABT_LIKELY(x) __builtin_expect(!!(x), 1)

#define WABT_VECTORCALL

#if __MINGW32__
#define WABT_PRINTF_FORMAT(format_arg, first_arg) \
  __attribute__((format(gnu_printf, (format_arg), (first_arg))))
#else
#define WABT_PRINTF_FORMAT(format_arg, first_arg) \
  __attribute__((format(printf, (format_arg), (first_arg))))
#endif

#ifdef __cplusplus
#define WABT_STATIC_ASSERT(x) static_assert((x), #x)
#else
#define WABT_STATIC_ASSERT(x) _Static_assert((x), #x)
#endif

#elif COMPILER_IS_MSVC

#include <intrin.h>
#include <string.h>

#define WABT_STATIC_ASSERT(x) _STATIC_ASSERT(x)
#define WABT_UNLIKELY(x) (x)
#define WABT_LIKELY(x) (x)
#define WABT_PRINTF_FORMAT(format_arg, first_arg)

#define WABT_VECTORCALL __vectorcall

#else

#error unknown compiler

#endif

#define WABT_UNREACHABLE abort()

#ifdef __cplusplus

#if COMPILER_IS_MSVC

#if SIZEOF_SIZE_T == 4
#define PRIzd "d"
#define PRIzx "x"
#elif SIZEOF_SIZE_T == 8
#define PRIzd "I64d"
#define PRIzx "I64x"
#else
#error "weird sizeof size_t"
#endif

#elif COMPILER_IS_CLANG || COMPILER_IS_GNU

#define PRIzd "zd"
#define PRIzx "zx"

#else

#error unknown compiler

#endif

#if HAVE_SNPRINTF
#define wabt_snprintf snprintf
#elif COMPILER_IS_MSVC
#include <cstdarg>
int wabt_snprintf(char* str, size_t size, const char* format, ...);
#else
#error no snprintf
#endif

#if COMPILER_IS_MSVC
int wabt_vsnprintf(char* str, size_t size, const char* format, va_list ap);
#else
#define wabt_vsnprintf vsnprintf
#endif

#if !HAVE_SSIZE_T
#if COMPILER_IS_MSVC
#if defined(_WIN64)
typedef signed __int64 ssize_t;
#else
typedef signed int ssize_t;
#endif
#else
typedef long ssize_t;
#endif
#endif

#if !HAVE_STRCASECMP
#if COMPILER_IS_MSVC
#define strcasecmp _stricmp
#else
#error no strcasecmp
#endif
#endif

double wabt_convert_uint64_to_double(uint64_t x);
float wabt_convert_uint64_to_float(uint64_t x);
double wabt_convert_int64_to_double(int64_t x);
float wabt_convert_int64_to_float(int64_t x);

#endif  /* __cplusplus */

#endif  /* WABT_CONFIG_H_ */
