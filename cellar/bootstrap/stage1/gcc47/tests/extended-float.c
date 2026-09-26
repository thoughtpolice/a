/* SPDX-FileCopyrightText: 2026 Austin Seipp
 * SPDX-License-Identifier: Apache-2.0 */
#include <stdio.h>
#include <pthread.h>
#define CHECK(x) do { if (!(x)) { fprintf(stderr, "floating check failed at %d\n", __LINE__); return 1; } } while (0)
typedef float quad __attribute__((mode(TF)));
typedef _Complex float cquad __attribute__((mode(TC)));
static volatile quad qa = 0x1.0000000000000000000000000001p0Q, qb = 3.0Q;
static volatile _Decimal32 s = 1.25DF;
static volatile _Decimal64 d = 123456.125DD;
static volatile _Decimal128 t = 123456789012345678901234567890.25DL;
static __attribute__((noinline)) cquad ratio(cquad a, cquad b) { return a/b; }
static void *worker(void *p) {
    int i;
    for (i=0; i<50; ++i) {
        _Decimal128 a = t;
        if ((a + 0.75DL) - a != 0.75DL || (_Decimal64)s != 1.25DD)
            return (void *)1;
    }
    return 0;
}
int main(void) {
    quad a = qa, b = qb;
    unsigned __int128 big = (unsigned __int128)1 << 110;
    cquad z;
    pthread_t first, second;
    void *result;
    CHECK(a > 1.0Q && a - 1.0Q == 0x1p-112Q);
    CHECK((a*b)/b == a && -b == -3.0Q);
    CHECK((unsigned __int128)(quad)big == big);
    CHECK((long double)(quad)1.25L == 1.25L);
    z = ratio(3.0Q + 4.0Qi, 1.0Q + 2.0Qi);
    CHECK(__real__ z > 2.19999Q && __real__ z < 2.20001Q);
    CHECK(__imag__ z > -0.40001Q && __imag__ z < -0.39999Q);
    CHECK(s + 0.75DF == 2.0DF && s * 4.0DF == 5.0DF && s / 5.0DF == 0.25DF);
    CHECK(d + 0.875DD == 123457.0DD && d * 8.0DD == 987649.0DD);
    CHECK(t + 0.75DL == 123456789012345678901234567891.0DL);
    CHECK((long)d == 123456L && (_Decimal64)(unsigned long)123456 == 123456.0DD);
    CHECK((double)s == 1.25 && (_Decimal128)(quad)1.25Q == 1.25DL);
    CHECK((quad)t > 1.23456789012345e29Q && (quad)t < 1.23456789012346e29Q);
    CHECK(pthread_create(&first, 0, worker, 0) == 0);
    CHECK(pthread_create(&second, 0, worker, 0) == 0);
    CHECK(pthread_join(first, &result) == 0 && !result);
    CHECK(pthread_join(second, &result) == 0 && !result);
    return 0;
}
