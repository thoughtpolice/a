/* SPDX-FileCopyrightText: © 2026 Austin Seipp
 * SPDX-License-Identifier: Apache-2.0
 */
#include <stdint.h>
#include <stdlib.h>
#include <math.h>

int main(void)
{
    char *end;
    int three = 3, four = 4, eight = 8, nine = 9, sixteen = 16;
    volatile uint64_t high = 0xc000000000000000ULL;
    double converted = high;
    long double extended = high;
    /* The seed cannot materialize floating constants, including constant
       casts. Runtime conversions let this gate check its floating codegen
       and parser without depending on that later compiler feature. */
    if ((long)(strtod("2.25tail", &end) * four) != 9 || *end != 't') return 1;
    if ((long)(strtod("1.0625", 0) * sixteen) != 17) return 2;
    if ((long)(strtod(" -0.125", 0) * eight) != -1) return 3;
    if ((long)(strtod("125E-3", 0) * eight) != 1) return 4;
    if ((uint64_t)strtod("4294967296", 0) != 4294967296ULL) return 5;
    if ((long)strtod("0x1.8p2", 0) != 6) return 6;
    if ((long)(strtod("0x1.8p-1", 0) * four) != 3) return 7;
    if ((long)strtod("6.25e+2", 0) != 625) return 8;
    if ((long)(ldexp(nine, -2) * four) != 9 || (long)ldexp(three, 5) != 96) return 9;
    if ((uint64_t)converted != high || (uint64_t)extended != high) return 10;
    return 0;
}
