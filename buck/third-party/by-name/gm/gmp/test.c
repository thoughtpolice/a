// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// Check a few results computed independently (with Python's integers)
// against GMP's, through the public header alone.

#include <gmp.h>
#include <stdio.h>
#include <string.h>

static int failures = 0;

static void expect(const char *what, const char *got, const char *want) {
    if (strcmp(got, want) != 0) {
        fprintf(stderr, "%s: got %s, want %s\n", what, got, want);
        failures++;
    }
}

int main(void) {
    char buf[512];
    mpz_t a, b, m;
    mpz_inits(a, b, m, NULL);

    mpz_fac_ui(a, 100);
    gmp_snprintf(buf, sizeof(buf), "%Zd", a);
    expect("100!", buf,
           "93326215443944152681699238856266700490715968264381621468592963895217599993229915608941463976156518286253697920827223758251185210916864000000000000000000000000");

    mpz_bin_uiui(a, 100, 50);
    gmp_snprintf(buf, sizeof(buf), "%Zd", a);
    expect("C(100, 50)", buf, "100891344545564193334812497256");

    // 3^(10^20) mod (10^9 + 7)
    mpz_set_ui(a, 3);
    mpz_ui_pow_ui(b, 10, 20);
    mpz_set_ui(m, 1000000007);
    mpz_powm(a, a, b, m);
    gmp_snprintf(buf, sizeof(buf), "%Zd", a);
    expect("powm", buf, "139421235");

    // floor(sqrt(2 * 10^60))
    mpz_ui_pow_ui(a, 10, 60);
    mpz_mul_ui(a, a, 2);
    mpz_sqrt(a, a);
    gmp_snprintf(buf, sizeof(buf), "%Zd", a);
    expect("sqrt", buf, "1414213562373095048801688724209");

    // 2^127 - 1 is prime, 2^127 + 1 is divisible by 3
    mpz_ui_pow_ui(a, 2, 127);
    mpz_sub_ui(b, a, 1);
    if (mpz_probab_prime_p(b, 25) == 0) {
        fprintf(stderr, "2^127 - 1 reported composite\n");
        failures++;
    }
    mpz_add_ui(b, a, 1);
    if (mpz_probab_prime_p(b, 25) != 0) {
        fprintf(stderr, "2^127 + 1 reported prime\n");
        failures++;
    }

    mpq_t p, q;
    mpq_inits(p, q, NULL);
    mpq_set_ui(p, 1, 3);
    mpq_set_ui(q, 1, 6);
    mpq_add(p, p, q);
    gmp_snprintf(buf, sizeof(buf), "%Qd", p);
    expect("1/3 + 1/6", buf, "1/2");
    mpq_clears(p, q, NULL);

    mpf_t f;
    mpf_init2(f, 256);
    mpf_sqrt_ui(f, 2);
    gmp_snprintf(buf, sizeof(buf), "%.30Ff", f);
    expect("sqrt(2)", buf, "1.414213562373095048801688724210");
    mpf_clear(f);

    expect("gmp_version", gmp_version, "6.3.0");
    if (mp_bits_per_limb != 64) {
        fprintf(stderr, "mp_bits_per_limb is %d\n", mp_bits_per_limb);
        failures++;
    }

    mpz_clears(a, b, m, NULL);
    return failures != 0;
}
