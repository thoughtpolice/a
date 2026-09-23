/* SPDX-FileCopyrightText: 2026 Austin Seipp
 * SPDX-License-Identifier: Apache-2.0 */
#include <stddef.h>
#include <stdio.h>
#include <stdlib.h>
#include "bfd.h"
#include "libbfd.h"
#include <stdint.h>
#include "bfdver.h"
#include <string.h>
#define CHECK(x) do { if (!(x)) { fprintf(stderr,"check failed at %d\n",__LINE__); return 1; } } while (0)
int main(void) {
    CHECK(BFD_ARCH_SIZE==64 && BFD_DEFAULT_TARGET_SIZE==64);
    CHECK(sizeof(bfd_vma)==8 && sizeof(bfd_size_type)==8 && sizeof(bfd_signed_vma)==8);
    CHECK(sizeof(file_ptr)==8 && (file_ptr)-1<0 && (ufile_ptr)-1>0);
    CHECK((uint64_t)1<<63 == UINT64_C(0x8000000000000000));
    CHECK(BFD_VERSION==241000000 && !strcmp(BFD_VERSION_STRING,"2.41"));
    CHECK(BFD_RELOC_32_PCREL != BFD_RELOC_X86_64_PLT32);
    CHECK(sizeof(((struct bfd_section *)0)->vma)==8);
    return 0;
}
