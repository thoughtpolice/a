/* SPDX-FileCopyrightText: © 2026 Austin Seipp
 * SPDX-License-Identifier: Apache-2.0
 */
#include <errno.h>
#include <setjmp.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

long entry_alignment(void);
int probe_setjmp(void);
static jmp_buf jump;
static volatile int phase;

static long sum(int count, ...)
{
    va_list ap;
    va_list copy;
    long value = 0;
    int i;
    va_start(ap, count);
    va_copy(copy, ap);
    for (i = 0; i < count; ++i) value += va_arg(ap, long);
    if (va_arg(copy, long) != 1) value = -100;
    va_end(copy);
    va_end(ap);
    return value;
}

int main(int argc, char **argv, char **envp)
{
    char buffer[80];
    int result;
    if (argc != 3 || strcmp(argv[1], "startup") || strcmp(argv[2], "ok")) return 1;
    if (!envp || !getenv("BOOTSTRAP_TEST") || strcmp(getenv("BOOTSTRAP_TEST"), "present")) return 2;
    if (entry_alignment()) return 3;
    if (getpid() <= 0 || read(-1, buffer, 1) != -1 || errno != EBADF) return 4;
    if (sum(9, 1L, 2L, 3L, 4L, 5L, 6L, 7L, 8L, 9L) != 45) return 5;
    snprintf(buffer, sizeof(buffer), "%s:%d:%ld", "args", 17, 123456789L);
    if (strcmp(buffer, "args:17:123456789")) return 6;
    result = setjmp(jump);
    if (phase == 0) { phase = 1; longjmp(jump, 0); }
    if (result != 1 || phase != 1) return 7;
    result = setjmp(jump);
    if (phase == 1) { phase = 2; longjmp(jump, 37); }
    if (result != 37 || phase != 2) return 8;
    if (probe_setjmp()) return 9;
    puts("native x86_64 startup, syscalls, varargs and setjmp passed");
    return 0;
}
