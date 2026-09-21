/* SPDX-FileCopyrightText: © 2026 Austin Seipp
 * SPDX-License-Identifier: Apache-2.0
 */
#include <stdarg.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>

int archive_answer(void);
int weak_answer(void);
extern int absent_weak(void) __attribute__((weak));

static double mixed(int tag, ...)
{
    int i;
    double value = 0;
    va_list ap;
    va_start(ap, tag);
    for (i = 1; i <= 10; ++i) {
        if (va_arg(ap, long) != i) return -1;
        value += va_arg(ap, double);
    }
    va_end(ap);
    return value;
}

int main(void)
{
    volatile uint64_t big = 0xfedcba9876543210ULL;
    volatile uint64_t divisor = 65537;
    volatile double a = 1.5;
    volatile double b = 2.25;
    volatile float f = 1.25f;
    volatile double hex = 0x1.8p2;
    volatile double large_hex = 0x100000001p0;
    union { double value; uint64_t bits; } zero;
    char text[64];
    if (big / divisor * divisor + big % divisor != big) return 1;
    if ((big >> 36) != 0xfedcba9 || (big << 60) != 0) return 2;
    if ((int64_t)-1234567890123LL / 9 != -137174210013LL) return 3;
    if (a * 2 != 3 || b * 4 != 9 || f * 4 != 5 || a * b * 8 != 27) return 4;
    if (hex != 6 || (uint64_t)large_hex != 4294967297ULL) return 8;
    zero.value = -0.0;
    if (zero.bits != 0x8000000000000000ULL) return 9;
    if (mixed(0, 1L, 1.5, 2L, 2.5, 3L, 3.5, 4L, 4.5, 5L, 5.5,
              6L, 6.5, 7L, 7.5, 8L, 8.5, 9L, 9.5, 10L, 10.5) != 60.0) return 5;
    if (archive_answer() != 42 || weak_answer() != 19 || absent_weak != 0) return 6;
    snprintf(text, sizeof(text), "%s %d", "archive", archive_answer());
    if (strcmp(text, "archive 42")) return 7;
    puts("arithmetic, floating point, mixed varargs, archives and weak symbols passed");
    return 0;
}
