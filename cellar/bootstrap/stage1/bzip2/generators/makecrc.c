// SPDX-FileCopyrightText: 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0
#include <stdint.h>
#include <stdio.h>
/* AUTODIN-II CRC: x^32 + x^26 + x^23 + x^22 + x^16 + x^12 + x^11 +
   x^10 + x^8 + x^7 + x^5 + x^4 + x^2 + x + 1, most significant bit first. */
int main(void) {
    unsigned i, bit;
    puts("#include \"bzlib_private.h\"\nUInt32 BZ2_crc32Table[256] = {");
    for (i=0;i<256;i++) {
        uint32_t value=(uint32_t)i<<24;
        for(bit=0;bit<8;bit++) value=(value<<1)^((value&0x80000000u)?0x04c11db7u:0);
        printf("0x%08xU%s\n",(unsigned)value,i==255?"":",");
    }
    puts("};");return fclose(stdout)!=0;
}
