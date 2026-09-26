/* SPDX-FileCopyrightText: 2026 Austin Seipp
 * SPDX-License-Identifier: Apache-2.0 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
extern long bootstrap_sum(long,long), bootstrap_intel(long);
long external_value=0x123456789abcdefL;
int bootstrap_weak=37;
extern long *bootstrap_pointer;
extern unsigned char bootstrap_float[],bootstrap_double[],bootstrap_large[],bootstrap_small[];
#define CHECK(x) do { if(!(x)) { fprintf(stderr,"check failed at %d\n",__LINE__); return 1; } } while(0)
int main(void) {
    uint32_t f; uint64_t d; long double large=0, small=0;
    CHECK(bootstrap_sum(0x100000000L,19)==0x300000013L);
    CHECK(bootstrap_intel(-17)==-85);
    CHECK(bootstrap_pointer==&external_value && *bootstrap_pointer==0x123456789abcdefL);
    CHECK(bootstrap_weak==37);
    memcpy(&f,bootstrap_float,4); CHECK(f==0x3dcccccdU);
    memcpy(&d,bootstrap_double,8); CHECK(d==UINT64_C(0x7e3ddd4baa009303));
    memcpy(&large,bootstrap_large,10); memcpy(&small,bootstrap_small,10);
    CHECK(large==strtold("1e4000",0) && small==strtold("1e-4000",0));
    return 0;
}
