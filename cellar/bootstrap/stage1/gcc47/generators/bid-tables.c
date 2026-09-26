/* SPDX-FileCopyrightText: 2026 Austin Seipp
 * SPDX-License-Identifier: Apache-2.0 */
/* Reconstruct GCC's BID/DPD tables from decimal digit encodings and exact
 * rounded-up reciprocals. The scaling choices are part of the upstream ABI;
 * the first few powers and the final 128-bit entry use special precisions. */
#include <stdint.h>
#include <stdio.h>
#include <gmp.h>
#define DEC_DPD2BIN 1
#define DEC_BIN2DPD 1
#include "decDPD.h"

static unsigned scale(unsigned n, unsigned bits)
{
    mpz_t power;
    unsigned result;
    if (bits == 128 && n <= 3) return 1;
    if (bits == 128 && n == 35) return 109;
    if (bits == 64 && n <= 1) return 1;
    if (bits == 64 && n == 2) return 5;
    mpz_init(power);
    mpz_ui_pow_ui(power, 10, n);
    result = mpz_sizeinbase(power, 2) - 1 + (bits == 128 ? 118 : 62) - bits;
    mpz_clear(power);
    return result;
}

static void reciprocal(unsigned n, unsigned bits, unsigned long long *low,
                       unsigned long long *high)
{
    mpz_t power, numerator, quotient;
    mpz_init(power); mpz_init(numerator); mpz_init(quotient);
    mpz_ui_pow_ui(power, 10, n);
    mpz_set_ui(numerator, 1);
    mpz_mul_2exp(numerator, numerator, bits + scale(n, bits));
    mpz_cdiv_q(quotient, numerator, power);
    *low = mpz_get_ui(quotient);
    mpz_fdiv_q_2exp(quotient, quotient, 64);
    *high = mpz_get_ui(quotient);
    mpz_clear(power); mpz_clear(numerator); mpz_clear(quotient);
}

int main(void)
{
    unsigned n, group;
    unsigned long long low, high, multiplier = 1;
    puts("static const UINT128 reciprocals10_128[] = {");
    puts("{{0ULL, 0ULL}},");
    for (n = 1; n <= 35; ++n) {
        reciprocal(n, 128, &low, &high);
        printf("{{%lluULL, %lluULL}},\n", low, high);
    }
    puts("};\nstatic const int recip_scale[] = {");
    for (n = 0; n <= 35; ++n) printf("%u,\n", scale(n, 128));
    puts("};\nstatic const int short_recip_scale[] = {");
    for (n = 0; n <= 17; ++n) printf("%u,\n", scale(n, 64));
    puts("};\nstatic const unsigned long long reciprocals10_64[] = {1ULL,");
    for (n = 1; n <= 17; ++n) {
        reciprocal(n, 64, &low, &high);
        if (high) return 1;
        printf("%lluULL,\n", low);
    }
    puts("};");
    for (group = 0; group < 6; ++group) {
        if (!group) puts("static const UINT64 d2b[] = {");
        else printf("static const UINT64 d2b%u[] = {\n", group + 1);
        for (n = 0; n < 1024; ++n)
            printf("%lluULL,\n", (unsigned long long)DPD2BIN[n] * multiplier);
        puts("};");
        multiplier *= 1000;
    }
    for (group = 0; group < 5; ++group) {
        if (!group) puts("static const UINT64 b2d[] = {");
        else printf("static const UINT64 b2d%u[] = {\n", group + 1);
        for (n = 0; n < 1000; ++n)
            printf("%lluULL,\n", (unsigned long long)BIN2DPD[n] << (10 * group));
        puts("};");
    }
    return ferror(stdout) ? 1 : 0;
}
