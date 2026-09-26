/* SPDX-FileCopyrightText: © 2026 Austin Seipp
 * SPDX-License-Identifier: Apache-2.0
 *
 * libc++ waits on atomics with these names from <linux/futex.h> and musl's
 * <sys/syscall.h>. No thread waits on the word, so a wake finds nobody and a
 * wait on a stale value returns at once.
 */
#include <errno.h>
#include <linux/futex.h>
#include <stdio.h>
#include <sys/syscall.h>
#include <unistd.h>

int main(void)
{
    int word = 0;
    if (syscall(SYS_futex, &word, FUTEX_WAKE_PRIVATE, 1, 0, 0, 0) != 0)
        return 1;
    if (syscall(SYS_futex, &word, FUTEX_WAIT_PRIVATE, 1, 0, 0, 0) != -1 || errno != EAGAIN)
        return 1;
    puts("passed");
    return 0;
}
