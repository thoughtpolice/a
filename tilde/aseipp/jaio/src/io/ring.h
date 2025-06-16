// SPDX-FileCopyrightText: © 2024-2025 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

#ifndef __IO__RING_H__
#define __IO__RING_H__

/* --------------------------------------------------------------- */

struct ring {
  struct io_uring ring;
  unsigned int qd;
  void* cookie;
  unsigned int flags;
};

#define RING_F_DYNVAR 0x00080000

#define RING_SETFLAG(r, f) do { r->flags |=  (f); } while (0)
#define RING_CLRFLAG(r, f) do { r->flags &= ~(f); } while (0)

/* --------------------------------------------------------------- */

struct ring* ring_new(struct ring* r, unsigned int qd, int* fds, size_t nfds, void* cookie);
void ring_delete(struct ring* r);
void ring_destroy(struct ring** r);

/* --------------------------------------------------------------- */

#endif /* __IO__RING_H__ */
