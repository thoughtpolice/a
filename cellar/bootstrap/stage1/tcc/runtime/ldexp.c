/* SPDX-FileCopyrightText: © 2026 Austin Seipp
 * SPDX-License-Identifier: Apache-2.0
 */

/* TCC's hexadecimal-literal parser needs binary exponent scaling. Keep the
   intermediate in x87 extended precision and round once when storing double.
   C handles the SSE argument/result moves absent from the early assembler. */
double ldexp(double value, int exponent)
{
    double result;
    __asm__ __volatile__(
        "fildl %2\n\tfldl %1\n\tfscale\n\tfstp %%st(1)\n\tfstpl %0"
        : "=m" (result) : "m" (value), "m" (exponent) : "memory");
    return result;
}
