/* SPDX-FileCopyrightText: 2026 Austin Seipp
 * SPDX-License-Identifier: Apache-2.0 */
#include <stdio.h>
typedef unsigned long long UINT64;
typedef struct { UINT64 w[2]; } UINT128;
#include "bid2dpd_dpd2bid.h"
#define PRINT(x) do { unsigned i; for (i = 0; i < sizeof(x)/sizeof(x[0]); ++i) printf("%llu\n", (unsigned long long)x[i]); } while (0)
int main(void)
{
    unsigned i;
    for (i = 0; i < sizeof(reciprocals10_128)/sizeof(reciprocals10_128[0]); ++i)
        printf("%llu\n%llu\n", reciprocals10_128[i].w[0], reciprocals10_128[i].w[1]);
    PRINT(recip_scale); PRINT(short_recip_scale); PRINT(reciprocals10_64);
    PRINT(d2b); PRINT(d2b2); PRINT(d2b3); PRINT(d2b4); PRINT(d2b5); PRINT(d2b6);
    PRINT(b2d); PRINT(b2d2); PRINT(b2d3); PRINT(b2d4); PRINT(b2d5);
    return ferror(stdout) ? 1 : 0;
}
