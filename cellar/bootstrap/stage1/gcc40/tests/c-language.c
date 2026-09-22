/* SPDX-FileCopyrightText: 2026 Austin Seipp
 * SPDX-License-Identifier: Apache-2.0 */
#include <stdarg.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#define CHECK(x) do { if (!(x)) { fprintf(stderr,"C check failed at %d\n",__LINE__); return 1; } } while (0)
struct pair { long a, b, c; };
static struct pair combine(struct pair a, struct pair b) {
    struct pair r = {a.a+b.a, a.b+b.b, a.c+b.c}; return r;
}
static long double arguments(int n, ...) {
    va_list a, b;
    long double r = 0;
    int i;
    va_start(a,n); va_copy(b,a);
    for(i=0;i<n;++i) r += va_arg(a,long double);
    r -= va_arg(b,long double);
    va_end(b); va_end(a); return r;
}
static int vla(int n) {
    int a[n], i, s=0;
    for(i=0;i<n;++i) a[i]=i*i+3;
    for(i=n;i--;) s+=a[i];
    return s;
}
static int jumps(int n) {
    static void *labels[]={&&first,&&second,&&third};
    if(n<0||n>2) return -1;
    goto *labels[n];
first: return 19;
second: return 31;
third: return 47;
}
static unsigned long arithmetic(unsigned long a, unsigned long b) {
    return (a/b)*b+a%b;
}
int main(void) {
    struct pair a={0x123456789L,9,-7}, b={11,-3,18}, r=combine(a,b);
    volatile unsigned long n=0xfedcba9876543210UL, divisor=0x1234567UL;
    union { double d; uint64_t u; } bits;
    CHECK(sizeof(void *)==8 && sizeof(long)==8 && sizeof(long double)==16);
    CHECK(r.a==0x123456794L && r.b==6 && r.c==11);
    CHECK(vla(20)==2530);
    CHECK(jumps(0)==19 && jumps(1)==31 && jumps(2)==47 && jumps(3)==-1);
    CHECK(arithmetic(n,divisor)==n);
    CHECK(arguments(4,1.25L,2.5L,4.0L,8.0L)==14.5L);
    CHECK(({int x=5; x*x;})==25);
    bits.d=0x1.0000000000001p0;
    CHECK(bits.u==0x3ff0000000000001ULL);
    CHECK(__builtin_popcount(0xa5a55a5aU)==16);
    CHECK(__builtin_clz(1U)==31 && __builtin_ctz(256U)==8);
    CHECK(!strcmp("static C", "static C"));
    return 0;
}
