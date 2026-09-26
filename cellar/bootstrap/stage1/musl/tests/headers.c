/* SPDX-FileCopyrightText: © 2026 Austin Seipp
 * SPDX-License-Identifier: MIT */
#include <stdio.h>
#include <stdarg.h>
#include <stdint.h>
#include <stddef.h>
#include <sys/types.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <pthread.h>

typedef char size_is_64[sizeof(size_t) == 8 ? 1 : -1];
typedef char time_is_64[sizeof(time_t) == 8 ? 1 : -1];
typedef char stat_is_native[sizeof(struct stat) == 144 ? 1 : -1];
typedef char va_is_native[sizeof(va_list) == 24 ? 1 : -1];
typedef char syscall_aliases[SYS_write == __NR_write && SYS_write == 1 ? 1 : -1];
typedef char pthread_is_native[sizeof(pthread_mutex_t) == 40 ? 1 : -1];

static int check(int n, ...)
{
    va_list args, copy;
    int i;
    va_start(args, n);
    va_copy(copy, args);
    for (i = 0; i < n; i++) {
        if (va_arg(args, int) != i) return 1;
        if (va_arg(args, double) != i + 0.5) return 2;
    }
    if (va_arg(copy, int) != 0 || va_arg(copy, double) != 0.5) return 3;
    va_end(copy);
    va_end(args);
    return 0;
}

int main(void)
{
    return check(10, 0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5,
                 5, 5.5, 6, 6.5, 7, 7.5, 8, 8.5, 9, 9.5);
}
