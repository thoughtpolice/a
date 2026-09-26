/* SPDX-FileCopyrightText: 2026 Austin Seipp
 * SPDX-License-Identifier: Apache-2.0 */
#include "config.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
#include "bfd.h"
#define CHECK(x) do { if (!(x)) { fprintf(stderr,"profile fixture: line %d\n",__LINE__); return 1; } } while (0)
static void little(FILE *f, uint64_t value, int bytes) {
    while (bytes--) { fputc(value & 255, f); value >>= 8; }
}
int main(int argc, char **argv) {
    bfd *b; asection *text; asymbol **symbols; long n,i;
    bfd_vma low,high,parent=0,child=0; unsigned bins;
    FILE *f; char unit[16]="seconds";
    CHECK(argc==4);
    bfd_init(); b=bfd_openr(argv[1],NULL);
    CHECK(b && bfd_check_format(b,bfd_object));
    n=bfd_get_symtab_upper_bound(b); CHECK(n>0);
    symbols=malloc(n); CHECK(symbols);
    n=bfd_canonicalize_symtab(b,symbols); CHECK(n>0);
    for (i=0;i<n;i++) {
        if (!strcmp(symbols[i]->name,"profile_parent")) parent=bfd_asymbol_value(symbols[i]);
        if (!strcmp(symbols[i]->name,"profile_child")) child=bfd_asymbol_value(symbols[i]);
    }
    text=bfd_get_section_by_name(b,".text"); CHECK(text && parent && child && child<parent);
    low=text->vma; bins=(text->size+1)/2; high=low+2*bins;
    f=fopen(argv[3],"wb"); CHECK(f);
    fwrite("gmon",1,4,f); little(f,1,4); little(f,0,8); little(f,0,4);
    fputc(0,f); little(f,low,8); little(f,high,8);
    little(f,bins,4); little(f,100,4); fwrite(unit,1,15,f); fputc('s',f);
    for (i=0;i<bins;i++) little(f,i==(child-low)/2 ? 75 : i==(parent-low)/2 ? 25 : 0,2);
    /* A zero-count arc still declares the call-graph record format. */
    fputc(1,f); little(f,parent+1,8); little(f,child,8);
    little(f,atoi(argv[2]) ? 7 : 0,4);
    CHECK(!ferror(f)); CHECK(!fclose(f));
    free(symbols); CHECK(bfd_close(b)); return 0;
}
