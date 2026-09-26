/* SPDX-FileCopyrightText: 2026 Austin Seipp
 * SPDX-License-Identifier: Apache-2.0 */
#include "sysdep.h"
#include "dis-asm.h"
#include <stdarg.h>
#include <stdio.h>
static char text[512]; static size_t used;
static int emit(void *stream, const char *format, ...) {
    va_list ap; int n;
    va_start(ap,format); n=vsnprintf(text+used,sizeof(text)-used,format,ap); va_end(ap);
    if(n<0 || n>=sizeof(text)-used) abort(); used+=n; return n;
}
#define CHECK(x) do { if(!(x)) { fprintf(stderr,"check failed at %d: %s\n",__LINE__,text); return 1; } } while(0)
int main(void) {
    disassemble_info info; disassembler_ftype fn;
    unsigned char code[]={0x55,0x48,0x89,0xe5,0x48,0xb8,0xef,0xcd,0xab,0x89,0x67,0x45,0x23,0x01,0xc3};
    init_disassemble_info(&info,NULL,emit);
    info.arch=bfd_arch_i386; info.mach=bfd_mach_x86_64; info.endian=BFD_ENDIAN_LITTLE;
    info.buffer=code; info.buffer_vma=0x1000; info.buffer_length=sizeof(code);
    disassemble_init_for_target(&info);
    fn=disassembler(info.arch,FALSE,info.mach,NULL); CHECK(fn);
    CHECK(fn(0x1000,&info)==1 && strstr(text,"push") && strstr(text,"%rbp"));
    text[used=0]=0; CHECK(fn(0x1001,&info)==3 && strstr(text,"%rsp,%rbp"));
    text[used=0]=0; CHECK(fn(0x1004,&info)==10 && strstr(text,"0x123456789abcdef"));
    info.disassembler_options="intel"; text[used=0]=0;
    CHECK(fn(0x1001,&info)==3 && strstr(text,"rbp,rsp"));
    CHECK(!disassembler(bfd_arch_arm,FALSE,0,NULL));
    return 0;
}
