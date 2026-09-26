/* SPDX-FileCopyrightText: 2026 Austin Seipp
 * SPDX-License-Identifier: Apache-2.0 */
#include <math.h>
#include <fenv.h>
#include <float.h>
#include <stdio.h>
#define CHECK(x) do { if (!(x)) { fprintf(stderr,"native math: line %d\n",__LINE__); return 1; } } while (0)
static int near(long double a, long double b) { return fabsl(a-b)<0x1p-58L; }
int main(void) {
    volatile long double two=2, half=0.5L, one=1, three=3;
    CHECK(LDBL_MANT_DIG==64);
    CHECK(sqrtl(0x1p2000L)==0x1p1000L);
    CHECK(exp2l(16000)==0x1p16000L && exp2l(-16000)==0x1p-16000L);
    CHECK(log2l(0x1p12000L)==12000 && log2l(0x1p-12000L)==-12000);
    CHECK(near(log10l(1000),three) && near(logl(expl(one)),one));
    CHECK(near(atanl(one),0.7853981633974483096156608458198757L));
    CHECK(near(atan2l(one,one),atanl(one)));
    CHECK(near(asinl(half)+acosl(half),two*atanl(one)));
    CHECK(near(expm1l(log1pl(half)),half));
    CHECK(floorl(-1.25L)==-two && ceill(-1.25L)==-one && truncl(-1.25L)==-one);
    CHECK(fmodl(5.5L,two)==1.5L && remainderl(5.5L,two)==-half);
    CHECK(!signbit(fabs(-0.0)) && !signbit(fabsf(-0.0f)) && !signbit(fabsl(-0.0L)));
    CHECK(fesetround(FE_DOWNWARD)==0);
    CHECK(lrint(1.75)==1 && lrintf(-1.25f)==-2 && llrintl(-1.25L)==-2);
    CHECK(rintl(1.75L)==one);
    CHECK(fesetround(FE_TONEAREST)==0);
    CHECK(llrint(2.5)==2 && llrintf(3.5f)==4);
    CHECK(sqrt(4)==2 && sqrtf(9)==3);
    CHECK(fma(0x1.0000000000001p0,0x1.fffffffffffffp-1,-1)==0x1.ffffffffffffep-54);
    CHECK(fmaf(0x1.000002p0f,0x1.fffffep-1f,-1)==0x1.fffffcp-25f);
    CHECK(scalbnl(0x1p100L,-16545)==0x1p-16445L);
    CHECK(scalbnl(0x1p-100L,16483)==0x1p16383L);
    CHECK(hypotl(0x1p10000L,0)==0x1p10000L);
    CHECK(powl(two,2000)==0x1p2000L);
    CHECK(fmal(0x1.0000000000000002p0L,0x1.fffffffffffffffep-1L,-1)==0x1.fffffffffffffffcp-65L);
    return 0;
}
