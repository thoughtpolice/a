/* SPDX-FileCopyrightText: 1996, 1998, 2001, 2003-2006 Free Software Foundation, Inc.
 * SPDX-FileCopyrightText: 2026 Austin Seipp
 * SPDX-License-Identifier: GPL-3.0-or-later
 * C ports of the coreutils 6.10 Perl generators. See generators/README.md. */

#include <stdio.h>
#include <stdlib.h>
static int prime(unsigned n) {unsigned d;for(d=2;d<=n/d;d++)if(n%d==0)return 0;return 1;}
int main(int argc,char **argv) {
    unsigned primes[7],size,count=0,product=1,i,d,prev=2;char *end;
    if(argc!=2)return 1;
    size=strtoul(argv[1],&end,10);if(*end||size<2||size>7)return 1;
    for(i=2;count<size;i++)if(prime(i)){primes[count++]=i;product*=i;}
    printf("/* The first %u elements correspond to the incremental offsets of the\n   first %u primes (",size-1,size);
    for(i=0;i<size;i++)printf("%s%u",i?" ":"",primes[i]);
    printf(").  The %u(th) element is the\n   difference between that last prime and the next largest integer\n   that is not a multiple of those primes.  The remaining numbers\n   define the wheel.  For more information, see\n   http://www.utm.edu/research/primes/glossary/WheelFactorization.html.  */\n",size);
    for(i=3;;i+=2) {
        for(d=0;d<size;d++)if(i!=primes[d]&&i%primes[d]==0)break;
        if(d<size)continue;
        printf("%u%s\n",i-prev,i>product+1?"":",");prev=i;
        if(i>product+1)break;
    }
    return fclose(stdout)!=0;
}
