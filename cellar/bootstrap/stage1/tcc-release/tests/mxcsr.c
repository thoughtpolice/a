/* SPDX-FileCopyrightText: © 2026 Austin Seipp
 * SPDX-License-Identifier: MIT */
#include <stdlib.h>
int check_mxcsr(void);
unsigned long large_immediate(void);
int main(void)
{
    char *tail;
    if (large_immediate() != 0x101010101010101UL) return 1;
    if (strtoull("0xfedcba9876543210!", &tail, 0) != 0xfedcba9876543210ULL || *tail != '!') return 2;
    return check_mxcsr();
}
