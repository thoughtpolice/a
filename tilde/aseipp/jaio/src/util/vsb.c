// SPDX-FileCopyrightText: © 2024-2025 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/*
** This vsb implementation is largely a copy of the upstream vsb code, from
** libvarnish (v6.x), but with some modifications, and in my own style. The core
** is largely the same -- I've found it a useful abstraction.Many thanks to
** Poul-Henning, Dag-Erling, etc.
*/

/* -------------------------------------------------------------------------- */

#include <assert.h>
#include <errno.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <stdint.h>
#include <string.h>
#include <termios.h>
#include <unistd.h>

#include <mimalloc.h>

#include "util/macros.h"
#include "util/vsb.h"

/* -------------------------------------------------------------------------- */

#define	VSB_MINEXTENDSIZE	16		/* Should be power of 2. */

#ifdef PAGE_SIZE
#define	VSB_MAXEXTENDSIZE	PAGE_SIZE
#define	VSB_MAXEXTENDINCR	PAGE_SIZE
#else
#define	VSB_MAXEXTENDSIZE	4096
#define	VSB_MAXEXTENDINCR	4096
#endif

#define VSB_SETFLAG(v, f) do { v->flags |=  (f); } while (0)
#define VSB_CLRFLAG(v, f) do { v->flags &= ~(f); } while (0)

#define	VSB_HASROOM(s)		((s)->len < (s)->size - 1L)
#define	VSB_FREESPACE(s)	((s)->size - ((s)->len + 1L))
#define	VSB_CANEXTEND(s)	((s)->flags & VSB_F_AUTOSIZE)

/* -------------------------------------------------------------------------- */

#define vsb_dignified(v) \
  do { \
    J_ASSERT(v != NULL, "%s called with NULL vsb", __func__); \
    J_ASSERT(v->buf != NULL, "%s called with invalid buf pointer", __func__); \
    J_ASSERT(v->len < v->size, "%s wrote past end of vsb: %ld >= %ld", \
             __func__, v->len, v->size); \
  } while (0)

#define vsb_valid_state(v, state) \
  do { \
    J_ASSERT((v->flags & VSB_F_FINISHED) == state, \
             "%s called with %sfinished or corrupt vsb", __func__, \
             (state ? "un" : "")); \
  } while (0)

/* -------------------------------------------------------------------------- */

static size_t
vsb_extendsize(size_t len)
{
  size_t newlen;

  if (len < VSB_MAXEXTENDSIZE) {
    newlen = VSB_MINEXTENDSIZE;
    while (newlen < len) newlen *= 2;
  } else {
    newlen = roundup2(len, VSB_MAXEXTENDINCR);
  }

  J_ASSERT(newlen >= len, "vsb_extendsize: %lu < %lu", newlen, len);
  return newlen;
}

static int
vsb_extend(struct vsb* v, size_t addsize)
{
  size_t newsize;
  uint8_t* newbuf;

  if (!VSB_CANEXTEND(v)) return -1;

  newsize = vsb_extendsize(v->size + addsize);
  if (v->flags & VSB_F_DYNBUF) {
    newbuf = mi_realloc(v->buf, newsize);
    if (NULL == newbuf) return -1;
  } else {
    newbuf = mi_zalloc(newsize);
    if (NULL == newbuf) return -1;

    memcpy(newbuf, v->buf, v->size);
    VSB_SETFLAG(v, VSB_F_DYNBUF);
  }

  v->buf  = newbuf;
  v->size = newsize;
  return 0;
}

/* -------------------------------------------------------------------------- */

static struct vsb*
vsb_init(struct vsb* v, uint8_t* buf, size_t size, int flags)
{
  v->flags = flags;
  v->buf   = buf;
  v->size  = size;

  if (0 == (v->flags & VSB_F_AUTOSIZE)) {
    J_ASSERT(v->size > 1, "invalid buffer size for vsb");
  }

  // If the user also gave a buffer, then exit
  if (NULL != v->buf) return v;

  if (0 != (v->flags & VSB_F_AUTOSIZE)) {
    v->size = vsb_extendsize(v->size);
  }

  v->buf = mi_zalloc(v->size);
  if (NULL == v->buf) return NULL;
  VSB_SETFLAG(v, VSB_F_DYNBUF);
  return v;
}

struct vsb*
vsb_new(struct vsb* v, uint8_t* buf, size_t size, int flags)
{
  // If the user allocated a vsb, use it
  if (NULL != v) return vsb_init(v, buf, size, flags);

  // Otherwise, allocate one for them
  v = mi_zalloc(sizeof(*v));
  if (NULL == v) goto err;
  if (NULL == vsb_init(v, buf, size, flags)) goto err;
  VSB_SETFLAG(v, VSB_F_DYNVAR);
  return v;

err:
  mi_free(v);
  return NULL;
}

void
vsb_clear(struct vsb* v)
{
  vsb_dignified(v);

  VSB_CLRFLAG(v, VSB_F_FINISHED);
  v->error = 0;
  v->len = 0;
}

void
vsb_delete(struct vsb* v)
{
  vsb_dignified(v);

  bool dyn = v->flags & VSB_F_DYNVAR;
  if (v->flags & VSB_F_DYNBUF) mi_free(v->buf);

  szero(v);
  if (dyn) mi_free(v);
}

void
vsb_destroy(struct vsb** s)
{
  vsb_delete(*s);
  *s = NULL;
}

int
vsb_error(struct vsb* v)
{
  vsb_dignified(v);
  return v->error;
}

/* -------------------------------------------------------------------------- */

int
vsb_finish(struct vsb* v)
{
  vsb_dignified(v);
  vsb_valid_state(v, 0);

  VSB_SETFLAG(v, VSB_F_FINISHED);
  v->buf[v->len] = '\0';
  return v->error;
}

const uint8_t*
vsb_data(const struct vsb* v)
{
  vsb_dignified(v);
  vsb_valid_state(v, VSB_F_FINISHED);
  return v->buf;
}

const char*
vsb_string(const struct vsb* v)
{
  return (const char*)vsb_data(v);
}

size_t
vsb_len(const struct vsb* v)
{
  vsb_dignified(v);
  return v->len;
}

/* -------------------------------------------------------------------------- */

int
vsb_cat(struct vsb* v, const char* s)
{
  return vsb_bcat(v, (const uint8_t*)s, strlen(s));
}

int
vsb_bcat(struct vsb* v, const uint8_t* p, size_t len)
{
  vsb_dignified(v);
  vsb_valid_state(v, 0);
  if (0 != v->error) return v->error;
  if (len == 0) return 0;

  size_t free = VSB_FREESPACE(v);
  if (len > free) {
    if (0 > vsb_extend(v, len - free)) v->error = ENOMEM;
    if (0 != v->error) return v->error;
  }

  memcpy(v->buf + v->len, p, len);
  v->len += len;

  return -1;
}

/* -------------------------------------------------------------------------- */

int
vsb_vprintf(struct vsb* v, const char* fmt, va_list ap)
{
  vsb_dignified(v);
  vsb_valid_state(v, 0);

  J_ASSERT(fmt != NULL, "%s called with NULL format string!", __func__);
  if (0 != v->error) return v->error;

  size_t free;
  va_list copy;
  int len;

  do {
    free = VSB_FREESPACE(v);
    char* p = (char*)&v->buf[v->len];

    va_copy(copy, ap);
    len = vsnprintf(p, free + 1, fmt, copy);
    va_end(copy);

    if (len < 0) {
      v->error = errno;
      return -1;
    }
  } while (len > free && vsb_extend(v, len - free) == 0);

  if (VSB_FREESPACE(v) < len)
    len = VSB_FREESPACE(v);

  v->len += len;
  if (!VSB_HASROOM(v) && !VSB_CANEXTEND(v)) {
    v->error = ENOMEM;
  }

  J_ASSERT(v->len < v->size, "%s wrote past end of buffer: %ld >= %ld",
           __func__, v->len, v->size);

  if (0 != v->error) return v->error;
  return -1;
}

int
vsb_printf(struct vsb* v, const char* fmt, ...)
{
  int r;
  va_list ap;

  va_start(ap, fmt);
  r = vsb_vprintf(v, fmt, ap);
  va_end(ap);
  return r;
}

/* -------------------------------------------------------------------------- */
