// SPDX-FileCopyrightText: © 2024-2025 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

#ifndef __TESTING__MACROS_H__
#define __TESTING__MACROS_H__

/* --------------------------------------------------------------- */

#define countof(a) (sizeof(a)/sizeof(a[0]))
#define container_of(p, c, n) ((c *)((void *)p - offsetof(c, n)))

#define UNUSED(x) ((void)(x))
#define UNUSED_P __attribute__((unused))

#define MUST_CHECK __attribute__((warn_unused_result))

#define szero(p) \
  bzero(p, sizeof(*p))

#define J_ASSERT(e, ...) \
  do { \
    if (!(e)) { \
      fprintf(stderr, __VA_ARGS__); \
      exit(EXIT_FAILURE); \
    } \
  } while (0)

#define	roundup2(x, y)	(((x)+((y)-1))&(~((y)-1))) /* if y is power of two */

#define thread_local __thread

#if defined(__SANITIZE_ADDRESS__)

void __asan_poison_memory_region(void const volatile *addr, size_t size);
void __asan_unpoison_memory_region(void const volatile *addr, size_t size);

#define ASAN_POISON_MEMORY_REGION(addr, size) \
  __asan_poison_memory_region((addr), (size))
#define ASAN_UNPOISON_MEMORY_REGION(addr, size) \
  __asan_unpoison_memory_region((addr), (size))

#else /* !defined(__SANITIZE_ADDRESS) */

#define ASAN_POISON_MEMORY_REGION(addr, size) \
  ((void)(addr), (void)(size))
#define ASAN_UNPOISON_MEMORY_REGION(addr, size) \
  ((void)(addr), (void)(size))

#endif

/* --------------------------------------------------------------- */

#endif /* __TESTING__MACROS_H__ */
