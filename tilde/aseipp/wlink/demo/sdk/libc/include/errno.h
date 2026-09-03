// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

#ifndef CONSOLE_LIBC_ERRNO_H
#define CONSOLE_LIBC_ERRNO_H

#ifdef __cplusplus
extern "C" {
#endif

extern int errno;

#define EDOM 1
#define ERANGE 2
#define ENOENT 3
#define EIO 4
#define EBADF 5
#define ENOMEM 6
#define EACCES 7
#define EEXIST 8
#define EINVAL 9
#define EMFILE 10
#define ENOSYS 11

#ifdef __cplusplus
}
#endif

#endif
