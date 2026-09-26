/* SPDX-FileCopyrightText: 2026 Austin Seipp
 * SPDX-License-Identifier: MIT */
#include <stdlib.h>
#include <unistd.h>

typedef int ti __attribute__((mode(TI)));
typedef unsigned int uti __attribute__((mode(TI)));
static volatile ti numerator;
static volatile long divisor = 7;
static int initialized;

static void __attribute__((constructor)) start(void) { initialized = 17; }
static void __attribute__((destructor)) finish(void)
{
    if (initialized != 42) _exit(80);
}
static double _Complex __attribute__((noinline)) ratio(double _Complex a, double _Complex b)
{
    return a / b;
}
static int __attribute__((noinline)) bits(unsigned long x)
{
    return __builtin_popcountl(x);
}
int main(void)
{
    ti a, q, r;
    uti u, uq, ur;
    long double f;
    double _Complex z;
    if (initialized != 17) return 1;
    numerator = ((ti)1 << 100) + 317;
    a = numerator;
    q = a / divisor;
    r = a % divisor;
    if (q * divisor + r != a || r < 0 || r >= divisor) return 2;
    q = -a / divisor;
    r = -a % divisor;
    if (q * divisor + r != -a || r > 0 || -r >= divisor) return 3;
    u = ((uti)1 << 127) + (uti)a;
    uq = u / (unsigned long)divisor;
    ur = u % (unsigned long)divisor;
    if (uq * divisor + ur != u || ur >= (unsigned long)divisor) return 4;
    numerator = ((ti)1 << 100);
    f = (long double)numerator;
    if ((ti)f != numerator || f != 0x1p100L) return 5;
    z = ratio(3.0 + 4.0i, 1.0 + 2.0i);
    if (__real__ z < 2.19999 || __real__ z > 2.20001 || __imag__ z < -0.40001 || __imag__ z > -0.39999) return 6;
    if (bits(0xffff000100010001UL) != 19) return 7;
    initialized = 42;
    return 0;
}
