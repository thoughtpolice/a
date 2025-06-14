// SPDX-FileCopyrightText: © 2024-2025 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/* -------------------------------------------------------------------------- */

#include <assert.h>
#include <errno.h>
#include <stdarg.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <termios.h>
#include <unistd.h>

#include <mimalloc.h>

#include "util/co.h"
#include "util/macros.h"

/* -------------------------------------------------------------------------- */

static thread_local uint8_t __attribute__((aligned(16)))
__coro_buffer[coro_size(64)];

#if defined(__amd64__) && defined(__linux__)
// HACK XXX (aseipp): apparently, when using gcc, we need to put a '#' after
// '.text' section name. why? because the string in the attribute is literally
// emitted directly to gnu as, and normally when you use section(".text"),
// outputs a string like `.section .text,"aw",@progbits` -- but this is bad and
// causes warnings because you can't change the permissions of an existing
// section, and .text always exists by default. using # instead results in
// `.section .text#,"aw",@progbits`, slyly inserting a comment to suppress that,
// which is a ridiculous hack.
//
// however, clang does not need this; presumably the section name is passed
// directly to the MC layer. in fact, if we don't do this, then clang will use
// the _literal_ word `.text#` as the section name, creating a completely *new*
// section (it does not merge with the main .text section). and then it it won't
// be marked as CODE, resulting in an immediate SIGSEGV when you try to switch
// to a coroutine. that was a fun 15 minute debugging session
//
// apparently when I originally wrote this it was for gcc exclusively I guess; I
// never debugged this enough to realize this was happening. maybe 'clang
// -no-integrated-as' can fix this, or maybe its behavior changed in the
// intervening years, but. whatever.
//
// reference: https://stackoverflow.com/a/58455300/
#ifdef __clang__
__attribute__((section(".text")))
#else
__attribute__((section(".text#")))
#endif
const uint8_t co_swap_fn[64] = {
    0x48, 0x89, 0x26,       /* mov [rsi],rsp    */
    0x48, 0x8b, 0x27,       /* mov rsp,[rdi]    */
    0x58,                   /* pop rax          */
    0x48, 0x89, 0x6e, 0x08, /* mov [rsi+ 8],rbp */
    0x48, 0x89, 0x5e, 0x10, /* mov [rsi+16],rbx */
    0x4c, 0x89, 0x66, 0x18, /* mov [rsi+24],r12 */
    0x4c, 0x89, 0x6e, 0x20, /* mov [rsi+32],r13 */
    0x4c, 0x89, 0x76, 0x28, /* mov [rsi+40],r14 */
    0x4c, 0x89, 0x7e, 0x30, /* mov [rsi+48],r15 */
    0x48, 0x8b, 0x6f, 0x08, /* mov rbp,[rdi+ 8] */
    0x48, 0x8b, 0x5f, 0x10, /* mov rbx,[rdi+16] */
    0x4c, 0x8b, 0x67, 0x18, /* mov r12,[rdi+24] */
    0x4c, 0x8b, 0x6f, 0x20, /* mov r13,[rdi+32] */
    0x4c, 0x8b, 0x77, 0x28, /* mov r14,[rdi+40] */
    0x4c, 0x8b, 0x7f, 0x30, /* mov r15,[rdi+48] */
    0xff, 0xe0,             /* jmp rax          */
    0x90, 0x90, 0x90, 0x90, /* nop              */
    0x90, 0x90, 0x90,       /* nop              */
};

static void coro_crash() {
  J_ASSERT(false, "co_crash called! your coroutine should never return!");
}

/* co_swap(to, from): swap ${from} coro ${to} coro */
void (*__coro_swap)(uint8_t *,
                    uint8_t *) = (void (*)(uint8_t *, uint8_t *))co_swap_fn;

#else
#error system unsupported (x86_64-linux only)
#endif

/* -------------------------------------------------------------------------- */

static thread_local void *__coro_active = NULL;

static struct coro *coro_make(struct coro *co, size_t size,
                              void (*coro_entry)(void), void *cookie) {
  bzero(co->name, 16);
  co->flags = 0;
  co->cookie = cookie;
  co->parent = __coro_active;
  co->done = false;
  co->ret = EXIT_FAILURE;

#if defined(__amd64__) && defined(__linux__)
  uint64_t *p = (uint64_t *)(co->co + size); /* top of stack */
  *--p = (uint64_t)coro_crash;               /* crash if 'return' */
  *--p = (uint64_t)coro_entry;               /* entry frame */
  *(uint64_t *)(co->co) = (uint64_t)p;       /* coro sp */
  ASAN_POISON_MEMORY_REGION(co->co, size);
#else
#error system unsupported (x86_64-linux only)
#endif

  return co;
}

struct coro *coro_new(struct coro *co, size_t size, void (*entry)(void),
                      void *cookie) {
  if (!__coro_active)
    __coro_active = &__coro_buffer; /* init */

  if (NULL != co)
    return coro_make(co, size, entry, cookie);

  size += 512; /* allocate additional space for storage */
  co = mi_zalloc_aligned(coro_size(size), 16);
  if (NULL == co)
    goto err;
  if (NULL == coro_make(co, size, entry, cookie))
    goto err;
  CORO_SETFLAG(co, CORO_F_DYNVAR);
  return co;

err:
  mi_free(co);
  return NULL;
}

void coro_delete(struct coro *co) {
  J_ASSERT(co != (struct coro *)&__coro_buffer,
           "cannot delete thread's main coroutine!");

  szero(co);
  if (co->flags & CORO_F_DYNVAR)
    mi_free(co);
}

void coro_destroy(struct coro **co) {
  coro_delete(*co);
  *co = NULL;
}

/* -------------------------------------------------------------------------- */

struct coro *coro_self(void) {
  if (!__coro_active)
    __coro_active = &__coro_buffer; /* init */
  return __coro_active;
}

void coro_switch(struct coro *to) {
  struct coro *from = __coro_active;

  J_ASSERT(to->done != true, "coroutine is already completed!");
  __coro_active = to;
  __coro_swap(to->co, from->co);
}

/* -------------------------------------------------------------------------- */
