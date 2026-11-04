/* SPDX-License-Identifier: MIT */
#ifndef LIBURING_COMPAT_H
#define LIBURING_COMPAT_H

/*
 * What liburing's configure writes here, decided from the headers at
 * compile time rather than by probing one build host, so the same file
 * works with old and new kernel headers and libcs. glibc 2.42 and later
 * include <linux/openat2.h> from <fcntl.h>, for example, so defining
 * struct open_how unconditionally breaks there.
 */

#include <stdint.h>

/* <linux/fs.h>, which io_uring.h includes, defines it the same way. */
typedef int __kernel_rwf_t;

#if __has_include(<linux/time_types.h>)
#include <linux/time_types.h>
#else
struct __kernel_timespec {
    int64_t		tv_sec;
    long long	tv_nsec;
};
#endif
/* Included above, or defined in its place. */
#define UAPI_LINUX_IO_URING_H_SKIP_LINUX_TIME_TYPES_H 1

#if __has_include(<linux/openat2.h>)
#include <linux/openat2.h>
#else
struct open_how {
    uint64_t	flags;
    uint64_t	mode;
    uint64_t	resolve;
};
#endif

#include <sys/stat.h>

/* Linux 5.16 added futex_waitv and these two macros together. */
#if __has_include(<linux/futex.h>)
#include <linux/futex.h>
#endif
#ifndef FUTEX_WAITV_MAX
#define FUTEX_32	2
#define FUTEX_WAITV_MAX	128

struct futex_waitv {
    uint64_t	val;
    uint64_t	uaddr;
    uint32_t	flags;
    uint32_t	__reserved;
};
#endif

#include <linux/ioctl.h>

#ifndef BLOCK_URING_CMD_DISCARD
#define BLOCK_URING_CMD_DISCARD _IO(0x12, 0)
#endif

#endif
