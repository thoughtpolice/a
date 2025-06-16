// SPDX-FileCopyrightText: © 2024-2025 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

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
#include <liburing.h>

#include "util/macros.h"

#include "io/ring.h"

/* -------------------------------------------------------------------------- */

static struct ring*
ring_init(struct ring* r, unsigned int qd, int* fds, size_t nfds, void* cookie)
{
  struct io_uring_params p;
  szero(&p);

  r->qd = qd;
  r->cookie = cookie;
  r->flags = 0;

  if (0 != io_uring_queue_init_params(r->qd, &r->ring, &p)) return NULL;
  if (0 != io_uring_register_files(&r->ring, fds, nfds)) return NULL;

  return r;
}

struct ring*
ring_new(struct ring* r, unsigned int qd, int* fds, size_t nfds, void* cookie)
{
  if (NULL != r) return ring_init(r, qd, fds, nfds, cookie);

  r = mi_zalloc(sizeof(*r));
  if (r == NULL) goto err;
  if (NULL == ring_init(r, qd, fds, nfds, cookie)) goto err;
  RING_SETFLAG(r, RING_F_DYNVAR);
  return r;

err:
  mi_free(r);
  return NULL;
}

void
ring_delete(struct ring* r)
{
  io_uring_queue_exit(&r->ring);
  szero(r);
  if (r->flags & RING_F_DYNVAR) mi_free(r);
}

void
ring_destroy(struct ring** r)
{
  ring_delete(*r);
  *r = NULL;
}

int
ring_flush(struct ring* r)
{
  return io_uring_submit(&r->ring);
}


/* -------------------------------------------------------------------------- */
