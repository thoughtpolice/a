/* SPDX-FileCopyrightText: 1996, 1998, 2001, 2003-2006 Free Software Foundation, Inc.
 * SPDX-FileCopyrightText: 2026 Austin Seipp
 * SPDX-License-Identifier: GPL-3.0-or-later
 * C ports of the coreutils 6.10 Perl generators. See generators/README.md. */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <ctype.h>
int main(int argc,char **argv) {
    FILE *f;char *line=0,*t;size_t cap=0;ssize_t n;unsigned found=0;
    if(argc!=2||(f=fopen(argv[1],"r"))==0)return 1;
    puts("/* Define the magic numbers as given by statfs(2).\n   Please send additions to bug-coreutils@gnu.org and meskes@debian.org.\n   This file is generated automatically from ./stat.c. */\n\n#if defined __linux__");
    while((n=getline(&line,&cap,f))>=0) {
        char name[128],value[64];int end=0,i;
        if(n&&line[n-1]=='\n')line[--n]=0;
        t=line;while(*t==' '||*t=='\t')++t;
        if(t==line||strncmp(t,"case S_MAGIC_",13))continue;
        if(sscanf(t,"case %127[A-Za-z0-9_]: /* %63[0-9A-Fa-fx] */%n",name,value,&end)!=2||!end||t[end]||strlen(value)<3||strncmp(value,"0x",2))return 1;
        for(i=2;value[i];i++)if(!isxdigit((unsigned char)value[i]))return 1;
        printf("# define %s %s\n",name,value);++found;
    }
    free(line);if(ferror(f)||fclose(f)||!found)return 1;
    puts("#elif defined __GNU__\n# include <hurd/hurd_types.h>\n#endif");
    return fclose(stdout)!=0;
}
