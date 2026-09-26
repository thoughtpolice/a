/* SPDX-FileCopyrightText: 2026 Austin Seipp
 * SPDX-License-Identifier: Apache-2.0 */
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#define CHECK(x) do { if (!(x)) { fprintf(stderr,"hexadecimal literal: line %d\n",__LINE__); return 1; } } while (0)
static int bits(long double x, uint64_t mantissa, unsigned short exponent) {
    uint64_t m; unsigned short e;
    memcpy(&m,&x,8); memcpy(&e,(char *)&x+8,2);
    return m==mantissa && e==exponent;
}
int main(void) {
    double d=0x1.00000000000008000001p0; float f=0x1.00000100000000000001p0f;
    uint64_t db; uint32_t fb;
    CHECK(bits(0x1p16000L,UINT64_C(0x8000000000000000),16383+16000));
    CHECK(bits(0x1p-16000L,UINT64_C(0x8000000000000000),16383-16000));
    CHECK(bits(0x1p-16382L,UINT64_C(0x8000000000000000),1));
    CHECK(bits(0x1p-16445L,1,0));
    CHECK(bits(0x1.fffffffffffffffep16383L,UINT64_C(0xffffffffffffffff),32766));
    CHECK(bits(0x1.0000000000000002p0L,UINT64_C(0x8000000000000001),16383));
    CHECK(bits(0x1.0000000000000001p0L,UINT64_C(0x8000000000000000),16383));
    CHECK(bits(0x1.0000000000000003p0L,UINT64_C(0x8000000000000002),16383));
    CHECK(bits(-0x0p0L,0,32768));
    memcpy(&db,&d,8); memcpy(&fb,&f,4);
    CHECK(db==UINT64_C(0x3ff0000000000001) && fb==0x3f800001U);
    CHECK(0b1.1p2==6);
    return 0;
}
