// SPDX-FileCopyrightText: © 2024-2025 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

#ifndef __UTIL__CO_H__
#define __UTIL__CO_H__

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

/* --------------------------------------------------------------- */

struct coro {
  char name[16];
  void *cookie;
  struct coro *parent;
  int flags;
  int ret;
  bool done;

  uint8_t co[0] __attribute__((aligned(16)));
};

#define CORO_F_DYNVAR 0x00080000

#define CORO_SETFLAG(c, f)                                                     \
  do {                                                                         \
    c->flags |= (f);                                                           \
  } while (0)
#define CORO_CLRFLAG(c, f)                                                     \
  do {                                                                         \
    c->flags &= ~(f);                                                          \
  } while (0)

#define coro_size(s) (sizeof(struct coro) + s)

#define coro_autonew(size, entry, cookie) coro_new(NULL, size, entry, cookie)

#define coro_yield() coro_switch(coro_self()->parent)

#define coro_cookie() (coro_self()->cookie)

#define coro_return(r)                                                         \
  do {                                                                         \
    struct coro *__co_self = coro_self();                                      \
    __co_self->done = true;                                                    \
    __co_self->ret = r;                                                        \
    coro_switch(__co_self->parent);                                            \
  } while (0)

#define coro_done(co) (co->done == true)

struct coro *coro_new(struct coro *co, size_t size, void (*entry)(void),
                      void *cookie);

struct coro *coro_self(void);
void coro_switch(struct coro *);

void coro_delete(struct coro *);
void coro_destroy(struct coro **);

/* --------------------------------------------------------------- */

#endif /* __UTIL__CO_H__ */
