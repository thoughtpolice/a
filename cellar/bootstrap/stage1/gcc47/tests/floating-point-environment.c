/* SPDX-FileCopyrightText: 2026 Austin Seipp
 * SPDX-License-Identifier: Apache-2.0
 *
 * Check the floating-point modes a program starts with. The driver links
 * crtfastmath.o for -Ofast and -ffast-math, which sets the SSE flush-to-zero
 * and denormals-are-zero bits, and crtprec32.o, crtprec64.o or crtprec80.o
 * for -mpc32, -mpc64 or -mpc80, which set the x87 precision. Without them, a
 * Linux process starts with both SSE bits clear and 64-bit x87 precision.
 */
#ifndef EXPECT_FAST_MATH
#define EXPECT_FAST_MATH 0
#endif

/* The x87 precision control field: 0 is 24 bits, 2 is 53 and 3 is 64. */
#ifndef EXPECT_PRECISION
#define EXPECT_PRECISION 3
#endif

#define MXCSR_DAZ (1u << 6)
#define MXCSR_FTZ (1u << 15)

int main(void)
{
    unsigned int mxcsr = __builtin_ia32_stmxcsr();
    unsigned short control;
    __asm__ volatile("fnstcw %0" : "=m"(control));
    if ((mxcsr & (MXCSR_DAZ | MXCSR_FTZ)) != (EXPECT_FAST_MATH ? MXCSR_DAZ | MXCSR_FTZ : 0))
        return 1;
    if ((control >> 8 & 3) != EXPECT_PRECISION)
        return 2;
    return 0;
}
