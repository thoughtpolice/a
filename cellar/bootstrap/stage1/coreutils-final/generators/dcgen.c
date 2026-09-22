/* SPDX-FileCopyrightText: 1996, 1998, 2001, 2003-2006 Free Software Foundation, Inc.
 * SPDX-FileCopyrightText: 2026 Austin Seipp
 * SPDX-License-Identifier: GPL-3.0-or-later
 * C ports of the coreutils 6.10 Perl generators. See generators/README.md. */

#include <stdio.h>
#include <stdlib.h>
int main(int argc,char **argv) {
    FILE *f;char *line=0;size_t cap=0;ssize_t n;int pending,i;
    if(argc!=2||(f=fopen(argv[1],"r"))==0)return 1;
    puts("static char const G_line[] =\n{");
    while((n=getline(&line,&cap,f))>=0) {
        if(n&&line[n-1]=='\n')--n;
        if(!n)continue;
        fputs("  ",stdout);pending=0;
        for(i=0;i<n;i++) {
            unsigned char c=line[i];
            if(c==' '||c=='\t'){pending=1;continue;}
            if(pending){fputs("' ',",stdout);pending=0;}
            putchar('\'');if(c=='\''||c=='\\')putchar('\\');putchar(c);fputs("',",stdout);
        }
        if(pending)fputs("' ',",stdout);
        puts("0,");
    }
    free(line);if(ferror(f)||fclose(f))return 1;
    puts("};");return fclose(stdout)!=0;
}
