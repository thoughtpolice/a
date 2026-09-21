/* SPDX-FileCopyrightText: 2026 Austin Seipp
 * SPDX-License-Identifier: Apache-2.0 */
#include <stdio.h>
#include <string.h>
#include <unistd.h>
#include "zlib.h"
#define CHECK(x) do { if (!(x)) { fprintf(stderr,"check failed at %d\n",__LINE__); return 1; } } while (0)
static unsigned char input[100000], output[100000], compressed[120000];
int main(int argc, char **argv) {
    unsigned i; uLongf n; int level, strategy;
    const unsigned char hello[] = {0x78,0x9c,0xcb,0x48,0xcd,0xc9,0xc9,0x07,0x00,0x06,0x2c,0x02,0x15};
    CHECK(crc32(0,(const Bytef *)"123456789",9)==0xcbf43926UL);
    CHECK(adler32(1,(const Bytef *)"123456789",9)==0x091e01deUL);
    n=sizeof(output); CHECK(uncompress(output,&n,hello,sizeof(hello))==Z_OK);
    CHECK(n==5 && !memcmp(output,"hello",5));
    for (i=0;i<sizeof(input);i++) input[i]=(i%71<64 ? 'a'+i%7 : i*37);
    for (level=0;level<=9;level+=3) for (strategy=0;strategy<=4;strategy++) {
        z_stream z = {0};
        CHECK(deflateInit2(&z,level,Z_DEFLATED,15,8,strategy)==Z_OK);
        z.next_in=input; z.avail_in=sizeof(input); z.next_out=compressed; z.avail_out=sizeof(compressed);
        CHECK(deflate(&z,Z_FINISH)==Z_STREAM_END);
        n=sizeof(output); CHECK(uncompress(output,&n,compressed,z.total_out)==Z_OK);
        CHECK(n==sizeof(input) && !memcmp(input,output,n));
        CHECK(deflateEnd(&z)==Z_OK);
    }
    if (argc>1) {
        gzFile f=gzopen("roundtrip.gz","wb9"); FILE *mark;
        CHECK(f && gzwrite(f,input,sizeof(input))==sizeof(input));
        CHECK(gzprintf(f," %s %d", "tail",42)==8 && gzclose(f)==Z_OK);
        f=gzopen("roundtrip.gz","rb"); CHECK(f);
        CHECK(gzread(f,output,sizeof(output))==sizeof(output) && !memcmp(input,output,sizeof(input)));
        CHECK(gztell(f)==sizeof(input));
        CHECK(gzseek(f,99999,SEEK_SET)==99999 && gzgetc(f)==input[99999]);
        CHECK(gzread(f,output,10)==8 && !memcmp(output," tail 42",8));
        CHECK(gzgetc(f)==-1 && gzeof(f));
        CHECK(gzclose(f)==Z_OK && unlink("roundtrip.gz")==0);
        mark=fopen("passed","w"); CHECK(mark && fputs("passed\n",mark)>=0 && fclose(mark)==0);
    }
    return 0;
}
