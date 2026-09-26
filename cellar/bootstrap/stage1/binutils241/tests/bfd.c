/* SPDX-FileCopyrightText: 2026 Austin Seipp
 * SPDX-License-Identifier: Apache-2.0 */
#include "sysdep.h"
#include "bfd.h"
#include <stdint.h>
#define CHECK(x) do { if (!(x)) { fprintf(stderr,"check failed at %d: %s\n",__LINE__,bfd_errmsg(bfd_get_error())); return 1; } } while (0)
int main(int argc, char **argv) {
    bfd *b; asection *section; asymbol **symbols; long count; unsigned i;
    const bfd_vma address = UINT64_C(0x123456780000);
    unsigned char input[32], output[32]; const char **targets;
    bfd_init();
    targets=bfd_target_list(); CHECK(targets);
    for (i=0;targets[i];i++) CHECK(!strstr(targets[i],"elf32") && !strstr(targets[i],"nacl"));
    free(targets);
    if (argc==3) {
        b=bfd_openr(argv[1],NULL); CHECK(b && bfd_check_format(b,bfd_object));
        CHECK(bfd_get_arch(b)==bfd_arch_i386 && bfd_get_mach(b)==bfd_mach_x86_64);
        CHECK(!strcmp(bfd_get_target(b),"elf64-x86-64"));
        section=bfd_get_section_by_name(b,".text"); CHECK(section && bfd_section_size(section)>0);
        count=bfd_get_symtab_upper_bound(b); CHECK(count>0); symbols=malloc(count); CHECK(symbols);
        CHECK(bfd_canonicalize_symtab(b,symbols)>0); free(symbols); CHECK(bfd_close(b));
        b=bfd_openr(argv[2],NULL); CHECK(b && bfd_check_format(b,bfd_archive));
        {
            bfd *member=bfd_openr_next_archived_file(b,NULL);
            CHECK(member && bfd_check_format(member,bfd_object) && bfd_get_arch(member)==bfd_arch_i386);
            CHECK(bfd_close(member) && bfd_close(b));
        }
        return 0;
    }
    CHECK(argc==1);
    for(i=0;i<sizeof(input);i++) input[i]=i*7;
    b=bfd_openw("native.o","elf64-x86-64"); CHECK(b);
    CHECK(bfd_set_format(b,bfd_object) && bfd_set_arch_mach(b,bfd_arch_i386,bfd_mach_x86_64));
    section=bfd_make_section_with_flags(b,".data",SEC_ALLOC|SEC_LOAD|SEC_DATA|SEC_HAS_CONTENTS); CHECK(section);
    CHECK(bfd_set_section_alignment(section,3) && bfd_set_section_size(section,sizeof(input)) && bfd_set_section_vma(section,address));
    {
        asymbol *symbol=bfd_make_empty_symbol(b); CHECK(symbol);
        symbol->name="bootstrap_marker"; symbol->value=4; symbol->flags=BSF_GLOBAL; symbol->section=section;
        CHECK(bfd_set_symtab(b,&symbol,1));
        CHECK(bfd_set_section_contents(b,section,input,0,sizeof(input)) && bfd_close(b));
    }
    b=bfd_openr("native.o",NULL); CHECK(b && bfd_check_format(b,bfd_object));
    section=bfd_get_section_by_name(b,".data"); CHECK(section);
    CHECK(bfd_section_vma(section)==address && bfd_section_size(section)==sizeof(input));
    CHECK(bfd_get_section_contents(b,section,output,0,sizeof(output)) && !memcmp(input,output,sizeof(input)));
    count=bfd_get_symtab_upper_bound(b); CHECK(count>0); symbols=malloc(count); CHECK(symbols);
    count=bfd_canonicalize_symtab(b,symbols); CHECK(count>0);
    for (i=0;i<count;i++) if (!strcmp(symbols[i]->name,"bootstrap_marker")) break;
    CHECK(i<count && (symbols[i]->flags&BSF_GLOBAL) && bfd_asymbol_value(symbols[i])==address+4);
    free(symbols); CHECK(bfd_close(b));
    {
        FILE *f=fopen("invalid.o","w"); CHECK(f && fwrite("\177ELF",1,4,f)==4 && fclose(f)==0);
        b=bfd_openr("invalid.o",NULL); CHECK(b && !bfd_check_format(b,bfd_object)); CHECK(bfd_close(b));
        f=fopen("passed","w"); CHECK(f && fputs("passed\n",f)>=0 && fclose(f)==0);
    }
    return 0;
}
