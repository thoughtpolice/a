// SPDX-FileCopyrightText: © 2024-2025 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

#ifndef __IO__ASYNC_H__
#define __IO__ASYNC_H__

/* --------------------------------------------------------------- */

// -- Event loop utilities

int dispatch_cqe(struct ring *r) MUST_CHECK;

// -- Basics

ssize_t await_nop(struct ring *r, int flags);
ssize_t await_fsync(struct ring *r, int fd, unsigned fsync_flags, int sqe_flags);

#if 0 // not implemented
ssize_t await_sync_file_range(struct ring *r);
#endif

ssize_t await_cancel(struct ring *r, void *priv, int cancel_flags, int sqe_flags);
ssize_t await_link_timeout(struct ring *r, struct __kernel_timespec *ts, int ts_flags, int sqe_flags);

// -- File handles: read/write

ssize_t await_readv(struct ring *r, int fd, const struct iovec *vecs, unsigned int nvecs, off_t off, int flags);
ssize_t await_read(struct ring *r, int fd, void* p, size_t size, off_t off, int flags);
ssize_t await_read_fixed(struct ring *r, int fd, void *buf, unsigned nbytes, off_t offset, int buf_index, int flags);

ssize_t await_writev(struct ring *r, int fd, const struct iovec *vecs, unsigned int nvecs, off_t off, int flags);
ssize_t await_write(struct ring *r, int fd, void* p, size_t size, off_t off, int flags);
ssize_t await_write_fixed(struct ring *r, int fd, void *buf, unsigned nbytes, off_t offset, int buf_index, int flags);

// -- Network/socket I/O programming

ssize_t await_sendmsg(struct ring *r, int fd, struct msghdr *msg, unsigned msg_flags, int sqe_flags);
ssize_t await_recvmsg(struct ring *r, int fd, struct msghdr *msg, unsigned msg_flags, int sqe_flags);

ssize_t await_accept(
  struct ring *r, int fd, struct sockaddr *addr, socklen_t *addrlen,
  int accept_flags, int sqe_flags
);

ssize_t await_connect(
  struct ring *r, int fd,
  struct sockaddr *addr, socklen_t addrlen,
  int sqe_flags
);

// -- Polling

ssize_t await_poll(int fd, struct sockaddr *addr, socklen_t *addrlen, int flags);
int await_poll_remove(struct ring *r, int fd);
int await_delay(struct ring *r, time_t seconds);

// -- Timeouts

ssize_t await_timeout_add(struct ring *r, struct __kernel_timespec *ts, unsigned count, int ts_flags, int sqe_flags);
ssize_t await_timeout_remove(struct ring *r, uint64_t priv, int ts_flags, int sqe_flags);

// -- Batching (with linked SQEs)

/* --------------------------------------------------------------- */

#endif /* __IO__ASYNC_H__ */
