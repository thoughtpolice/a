// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// Unlike the hosted header this one has an include guard: the SDK never
// toggles NDEBUG between inclusions.
#ifndef CONSOLE_LIBC_ASSERT_H
#define CONSOLE_LIBC_ASSERT_H

#ifdef __cplusplus
extern "C" {
#endif

_Noreturn void __console_assert_fail(const char* expression, const char* file, int line,
                                     const char* function);

#ifdef NDEBUG
#define assert(condition) ((void)0)
#else
#define assert(condition) \
  ((condition) ? (void)0 : __console_assert_fail(#condition, __FILE__, __LINE__, __func__))
#endif

#ifdef __cplusplus
}
#endif

#endif
