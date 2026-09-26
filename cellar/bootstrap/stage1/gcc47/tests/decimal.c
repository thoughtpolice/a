/* SPDX-FileCopyrightText: 2026 Austin Seipp
 * SPDX-License-Identifier: Apache-2.0 */
#define DECNUMDIGITS 50
#include <stdio.h>
#include <string.h>
#include "decNumber.h"
#include "decimal32.h"
#include "decimal64.h"
#include "decimal128.h"
#define CHECK(x) do { if (!(x)) { fprintf(stderr, "decimal check failed at %d\n", __LINE__); return 1; } } while (0)
int main(void)
{
    decContext ctx;
    decNumber a, b, sum, result;
    decimal32 d32;
    decimal64 d64;
    decimal128 d128;
    char text[100];
    decContextDefault(&ctx, DEC_INIT_BASE);
    ctx.digits = 34;
    ctx.traps = 0;
    decNumberFromString(&a, "1.20", &ctx);
    decNumberFromString(&b, "2.30", &ctx);
    decNumberAdd(&sum, &a, &b, &ctx);
    CHECK(!strcmp(decNumberToString(&sum, text), "3.50"));
    decNumberMultiply(&result, &sum, &b, &ctx);
    CHECK(!strcmp(decNumberToString(&result, text), "8.0500"));
    decNumberFromString(&a, "1", &ctx);
    decNumberFromString(&b, "3", &ctx);
    ctx.digits = 7;
    decNumberDivide(&result, &a, &b, &ctx);
    CHECK(!strcmp(decNumberToString(&result, text), "0.3333333"));
    CHECK(ctx.status & DEC_Inexact);
    decContextDefault(&ctx, DEC_INIT_DECIMAL32);
    ctx.traps = 0;
    decimal32FromString(&d32, "1234567", &ctx);
    CHECK(!strcmp(decimal32ToString(&d32, text), "1234567"));
    decContextDefault(&ctx, DEC_INIT_DECIMAL64);
    ctx.traps = 0;
    decimal64FromString(&d64, "-1234567890123456", &ctx);
    CHECK(!strcmp(decimal64ToString(&d64, text), "-1234567890123456"));
    decContextDefault(&ctx, DEC_INIT_DECIMAL128);
    ctx.traps = 0;
    decimal128FromString(&d128, "9876543210123456789012345678901234", &ctx);
    CHECK(!strcmp(decimal128ToString(&d128, text), "9876543210123456789012345678901234"));
    decimal128ToNumber(&d128, &a);
    CHECK(a.digits == 34 && !decNumberIsNegative(&a));
    decimal128FromString(&d128, "-Infinity", &ctx);
    decimal128ToNumber(&d128, &a);
    CHECK(decNumberIsInfinite(&a) && decNumberIsNegative(&a));
    decimal128FromString(&d128, "NaN", &ctx);
    decimal128ToNumber(&d128, &a);
    CHECK(decNumberIsNaN(&a));
    return 0;
}
