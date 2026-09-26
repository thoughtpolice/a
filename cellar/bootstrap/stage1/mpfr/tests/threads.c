/* SPDX-FileCopyrightText: 2026 Austin Seipp
 * SPDX-License-Identifier: Apache-2.0 */
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <mpfr.h>

static pthread_barrier_t gate;
#define CHECK(x) do { if (!(x)) { fprintf(stderr, "MPFR check failed at %d\n", __LINE__); abort(); } } while (0)

static void *worker(void *arg)
{
    long id = (long)arg;
    mpfr_prec_t precision = 160 + id;
    mpfr_rnd_t rounding = id ? MPFR_RNDD : MPFR_RNDU;
    mpfr_t x, y;
    int i;
    mpfr_set_default_prec(precision);
    mpfr_set_default_rounding_mode(rounding);
    mpfr_clear_flags();
    if (id) mpfr_set_underflow(); else mpfr_set_overflow();
    pthread_barrier_wait(&gate);
    CHECK(mpfr_get_default_prec() == precision);
    CHECK(mpfr_get_default_rounding_mode() == rounding);
    CHECK(!!mpfr_underflow_p() == !!id);
    CHECK(!!mpfr_overflow_p() == !id);
    mpfr_inits(x, y, (mpfr_ptr)0);
    for (i = 0; i < 40; i++) {
        mpfr_const_pi(x, MPFR_RNDN);
        mpfr_sin(y, x, MPFR_RNDN);
        mpfr_abs(y, y, MPFR_RNDN);
        CHECK(mpfr_cmp_ui_2exp(y, 1, -150) < 0);
        mpfr_const_log2(x, MPFR_RNDN);
        mpfr_exp(y, x, MPFR_RNDN);
        CHECK(mpfr_cmp_ui(y, 2) == 0);
    }
    mpfr_clears(x, y, (mpfr_ptr)0);
    mpfr_free_cache();
    return 0;
}

int main(void)
{
    pthread_t a, b;
    CHECK(mpfr_buildopt_tls_p());
    CHECK(!mpfr_buildopt_float128_p());
    CHECK(!mpfr_buildopt_decimal_p());
    mpfr_set_default_prec(93);
    mpfr_set_default_rounding_mode(MPFR_RNDZ);
    mpfr_clear_flags();
    CHECK(pthread_barrier_init(&gate, 0, 3) == 0);
    CHECK(pthread_create(&a, 0, worker, (void *)0) == 0);
    CHECK(pthread_create(&b, 0, worker, (void *)1) == 0);
    pthread_barrier_wait(&gate);
    CHECK(mpfr_get_default_prec() == 93);
    CHECK(mpfr_get_default_rounding_mode() == MPFR_RNDZ);
    CHECK(mpfr_flags_save() == 0);
    CHECK(pthread_join(a, 0) == 0 && pthread_join(b, 0) == 0);
    CHECK(pthread_barrier_destroy(&gate) == 0);
    mpfr_free_cache();
    return 0;
}
