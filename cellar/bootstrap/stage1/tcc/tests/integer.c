/* SPDX-FileCopyrightText: © 2026 Austin Seipp
 * SPDX-License-Identifier: Apache-2.0
 */
#include <stdint.h>

int main(void)
{
    volatile int size = 8;
    volatile int value = -12345;
    volatile unsigned int bits = 0x87654321U;
    volatile uint64_t big = 0xfedcba9876543210ULL;
    volatile uint64_t divisor = 65537;
    int shift;
    if (size * 2 != 16 || (size << 1) != 16) return 1;
    if (value / 7 != -1763 || value % 7 != -4) return 2;
    if ((value >> 5) != -386 || (bits >> 28) != 8) return 3;
    for (shift = 0; shift < 16; ++shift)
        if (((bits >> shift) << shift) != (bits & (0xffffffffU << shift))) return 4;
    if (big / divisor * divisor + big % divisor != big) return 5;
    if ((big >> 36) != 0xfedcba9 || (big << 60) != 0) return 6;
    return 0;
}
