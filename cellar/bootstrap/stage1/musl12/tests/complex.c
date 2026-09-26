/* SPDX-FileCopyrightText: 2026 Austin Seipp
 * SPDX-License-Identifier: MIT */
#include <complex.h>
#include <math.h>
#include <float.h>
#include <stdio.h>

static int near(double complex a, double complex b)
{
    return cabs(a-b) <= 2e-12 * (1 + cabs(b));
}
int main(void)
{
    double complex a, b;
    long double complex l;
    float complex f;
    int i;
    if (!near(cexp(I*acos(-1.0)), -1.0)) return 1;
    if (!near(csqrt(-4.0 + 0.0*I), 2.0*I)) return 2;
    if (!near(cpow(1.0+I, 2.0), 2.0*I)) return 3;
    for (i = 1; i < 30; ++i) {
        a = i*0.13 + I*(i*0.09 - 0.9);
        if (!near(cexp(clog(a)), a)) return 4;
        b = csqrt(a);
        if (!near(b*b, a)) return 5;
        if (!near(csin(a)*csin(a) + ccos(a)*ccos(a), 1.0)) return 6;
        if (!near(ctan(a)*ccos(a), csin(a))) return 7;
        if (!near(csinh(a), -I*csin(I*a))) return 8;
    }
    l = csqrtl(3.0L + 4.0Li);
    if (cabsl(l - (2.0L + 1.0Li)) > 1e-17L) return 9;
    l = cexpl(clogl(0.125L + 2.25Li));
    /* Upstream musl 1.2.5 cexpl delegates to double-precision cexp. */
    if (cabsl(l - (0.125L + 2.25Li)) > 8*DBL_EPSILON) return 10;
    f = csqrtf(3.0f + 4.0fi);
    if (cabsf(f - (2.0f + 1.0fi)) > 1e-6f) return 11;
    if (!isinf(creal(cproj(INFINITY + 1.0*I)))) return 12;
    return 0;
}
