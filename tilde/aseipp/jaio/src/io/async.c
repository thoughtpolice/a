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
#include <sys/poll.h>
#include <sys/timerfd.h>

#include <mimalloc.h>
#include <liburing.h>

#include "util/macros.h"
#include "util/co.h"

#include "io/ring.h"
#include "io/async.h"

/* -------------------------------------------------------------------------- */
/* -- I/O Framework --------------------------------------------------------- */

/* SQE dispatch logic. This routine effectively forms the "tail" of all async
 * i/o routines, since they must always yield to the scheduler loop after
 * queueing up submissions. When a corresponding CQE is pulled from the ring
 * for some given submission, the coroutine will resume.
 *
 * If the SQE/CQE entries (${sqe}, resp ${cqe}) are not pulled the given ring
 * ${r}, the behavior is undefined.
 *
 * If this function is NOT executed within a coroutine (i.e. it is called from
 * the main thread), the behavior is undefined.
 */

static int MUST_CHECK
dispatch_sqe(
    // ${r}: a ring to submit and pull completions from.
    struct ring *r,

    // ${sqe}: an I/O submission, pulled from the given ring ${r}.
    struct io_uring_sqe *sqe,

    // ${cqe}: an I/O completion, pulled from a given ring ${r}.
    struct io_uring_cqe *cqe,

    // ${sqe_flags}: flags for SQE submission. The primary use of this flag is
    // to allow SQE draining, for example, upon an fsync.
    int sqe_flags
) {
  struct coro *self = coro_self();

  // Setup SQE with user flags
  sqe->flags = sqe_flags;
  io_uring_sqe_set_data(sqe, self);

  // Dispatch back to the parent. Also ensure we aren't sitting on the main thread,
  // since otherwise nothing would make sense.
  J_ASSERT(self->parent != NULL,
    "dispatch_sqe cannot be called from the main thread!");
  coro_switch(self->parent);

  // We expect that the parent waited for the CQE to be fulfilled, so we peek
  // and make sure of it
  io_uring_peek_cqe(&r->ring, &cqe);
  J_ASSERT(cqe, "CQE was retrieved");

  // Mark as seen and return the result of the operation
  io_uring_cqe_seen(&r->ring, cqe);
  return cqe->res;
}

/* CQE dispatch logic. Whereas dispatch_sqe corresponds to the "tail" of all
 * asynchronous i/o operations, dispatch_cqe corresponds to the "tail" of the
 * event loop that drives coroutines. This function effectively pulls a CQE off
 * of a given ring, and resumes the coroutine associated with the respective
 * SQE.
 *
 * This function is kept separate from any event loop; is is straight-line and
 * only reaps CQEs and dispatches coroutines. This is so that the termination
 * criteria for any event loop -- the set of conditions telling us to *stop*
 * dispatches -- is completely separated from coroutine dispatch logic.
 */
int
dispatch_cqe(struct ring *r)
{
  int ret = EXIT_FAILURE;
  struct io_uring_cqe *cqe;
  struct coro *co;

  ret = io_uring_submit_and_wait(&r->ring, 1);
  if (ret < 0) return 1;

  ret = io_uring_wait_cqe(&r->ring, &cqe);
  if (ret < 0) return 1;

  co = io_uring_cqe_get_data(cqe);
  coro_switch(co);
  return 0;
}

// -------------------------------------
// -- I/O API: basics ------------------

ssize_t
await_nop(struct ring *r, int flags)
{
  struct io_uring_cqe *cqe = NULL;
  struct io_uring_sqe *sqe = io_uring_get_sqe(&r->ring);
  if (!sqe) return -1;
  io_uring_prep_nop(sqe);
  return dispatch_sqe(r, sqe, cqe, flags);
}

ssize_t
await_fsync(struct ring *r, int fd, unsigned fsync_flags, int sqe_flags)
{
  struct io_uring_cqe *cqe = NULL;
  struct io_uring_sqe *sqe = io_uring_get_sqe(&r->ring);
  if (!sqe) return -1;
  io_uring_prep_fsync(sqe, fd, fsync_flags);
  return dispatch_sqe(r, sqe, cqe, sqe_flags);
}

ssize_t
await_accept(
  struct ring *r,
  int fd,
  struct sockaddr *addr,
  socklen_t *addrlen,
  int accept_flags,
  int sqe_flags
) {
  struct io_uring_cqe *cqe = NULL;
  struct io_uring_sqe *sqe = io_uring_get_sqe(&r->ring);
  if (!sqe) return -1;
  io_uring_prep_accept(sqe, fd, addr, addrlen, accept_flags);
  return dispatch_sqe(r, sqe, cqe, sqe_flags);
}

ssize_t
await_connect(
  struct ring *r, int fd,
  struct sockaddr *addr, socklen_t addrlen,
  int sqe_flags
) {
  struct io_uring_cqe *cqe = NULL;
  struct io_uring_sqe *sqe = io_uring_get_sqe(&r->ring);
  if (!sqe) return -1;
  io_uring_prep_connect(sqe, fd, addr, addrlen);
  return dispatch_sqe(r, sqe, cqe, sqe_flags);
}

ssize_t
await_sync_file_range(struct ring *r)
{
  (void)r; // FIXME: implement
  return -1;
}

ssize_t
await_cancel(struct ring *r, void *priv, int cancel_flags, int sqe_flags)
{
  struct io_uring_cqe *cqe = NULL;
  struct io_uring_sqe *sqe = io_uring_get_sqe(&r->ring);
  if (!sqe) return -1;
  io_uring_prep_cancel(sqe, priv, cancel_flags);
  return dispatch_sqe(r, sqe, cqe, sqe_flags);
}

ssize_t
await_link_timeout(struct ring *r, struct __kernel_timespec *ts, int ts_flags, int sqe_flags)
{
  struct io_uring_cqe *cqe = NULL;
  struct io_uring_sqe *sqe = io_uring_get_sqe(&r->ring);
  if (!sqe) return -1;
  io_uring_prep_link_timeout(sqe, ts, ts_flags);
  return dispatch_sqe(r, sqe, cqe, sqe_flags);
}

// -------------------------------------
// -- I/O API: read/write --------------

#define MAKE_BASIC_AWAIT_OP(op) \
ssize_t await_##op##v(struct ring *r, int fd, const struct iovec *vecs, unsigned int nvecs, off_t off, int flags) \
{ \
  struct io_uring_cqe *cqe = NULL; \
  struct io_uring_sqe *sqe = io_uring_get_sqe(&r->ring); \
  if (!sqe) return -1; \
  io_uring_prep_##op##v(sqe, fd, vecs, nvecs, off); \
  return dispatch_sqe(r, sqe, cqe, flags); \
} \
\
ssize_t await_##op(struct ring *r, int fd, void* p, size_t size, off_t off, int flags) \
{ \
  struct iovec iov = { \
    .iov_base = p, \
    .iov_len  = size, \
  }; \
  return await_##op##v(r, fd, &iov, 1, off, flags); \
} \
\
ssize_t await_##op##_fixed(struct ring *r, int fd, void *buf, unsigned nbytes, off_t offset, int buf_index, int flags) \
{ \
  struct io_uring_cqe *cqe = NULL; \
  struct io_uring_sqe *sqe = io_uring_get_sqe(&r->ring); \
  if (!sqe) return -1; \
  io_uring_prep_##op##_fixed(sqe, fd, buf, nbytes, offset, buf_index); \
  return dispatch_sqe(r, sqe, cqe, flags); \
}

MAKE_BASIC_AWAIT_OP(read)
MAKE_BASIC_AWAIT_OP(write)

// -------------------------------------
// -- I/O API: send/recv msg -----------

#define MAKE_BASIC_SOCKMSG_OP(op) \
ssize_t await_##op(struct ring *r, int fd, struct msghdr *msg, unsigned msg_flags, int sqe_flags) \
{ \
  struct io_uring_cqe *cqe = NULL; \
  struct io_uring_sqe *sqe = io_uring_get_sqe(&r->ring); \
  if (!sqe) return -1; \
  io_uring_prep_##op(sqe, fd, msg, msg_flags); \
  return dispatch_sqe(r, sqe, cqe, sqe_flags); \
}

MAKE_BASIC_SOCKMSG_OP(sendmsg)
MAKE_BASIC_SOCKMSG_OP(recvmsg)

// -------------------------------------
// -- I/O API: polling -----------------

int
await_poll_add(struct ring *r, int fd, short mask, int flags)
{
  struct io_uring_cqe *cqe = NULL;
  struct io_uring_sqe *sqe = io_uring_get_sqe(&r->ring);
  if (!sqe) return -1;

  io_uring_prep_poll_add(sqe, fd, mask);
  return dispatch_sqe(r, sqe, cqe, flags);
}

int
await_poll_remove(struct ring *r, int fd)
{
  struct io_uring_cqe *cqe = NULL;
  struct io_uring_sqe *sqe = io_uring_get_sqe(&r->ring);
  if (!sqe) return -1;

  io_uring_prep_poll_remove(sqe, (__u64)&fd);
  return dispatch_sqe(r, sqe, cqe, 0);
}

int
await_delay(struct ring *r, time_t seconds)
{
  int ret = EXIT_FAILURE;

  struct itimerspec exp = {
    .it_interval = {},
		.it_value = { seconds, 0 },
  };

  int fd = timerfd_create(CLOCK_MONOTONIC, TFD_NONBLOCK);
  if (fd < 0) goto exit;
  if (timerfd_settime(fd, 0, &exp, NULL)) goto exit;

  ret = await_poll_add(r, fd, POLLIN, 0);
  assert(ret == POLLIN);
  ret = EXIT_SUCCESS;

exit:
  close(fd);
  return ret;
}

// -------------------------------------
// -- I/O API: timeouts ----------------

ssize_t
await_timeout_add(struct ring *r, struct __kernel_timespec *ts, unsigned count, int ts_flags, int sqe_flags)
{
  struct io_uring_cqe *cqe = NULL;
  struct io_uring_sqe *sqe = io_uring_get_sqe(&r->ring);
  if (!sqe) return -1;
  io_uring_prep_timeout(sqe, ts, count, ts_flags);
  return dispatch_sqe(r, sqe, cqe, sqe_flags);
}

ssize_t
await_timeout_remove(struct ring *r, uint64_t priv, int ts_flags, int sqe_flags)
{
  struct io_uring_cqe *cqe = NULL;
  struct io_uring_sqe *sqe = io_uring_get_sqe(&r->ring);
  if (!sqe) return -1;
  io_uring_prep_timeout_remove(sqe, priv, ts_flags);
  return dispatch_sqe(r, sqe, cqe, sqe_flags);
}

// -------------------------------------
// -- I/O API: batching ----------------

static thread_local bool __io_batching = false;

bool
await_batch_enable(void)
{
  bool old = __io_batching;
  __io_batching = true;
  return old;
}

bool
await_batch_disable(void)
{
  bool old = __io_batching;
  __io_batching = false;
  return old;
}

/* -------------------------------------------------------------------------- */
