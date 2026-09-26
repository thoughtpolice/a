/* SPDX-FileCopyrightText: 2026 Austin Seipp
 * SPDX-License-Identifier: Apache-2.0 */
/* Invoke the table writers supplied by the matching zlib sources. zlib 1.2.12
 * writes crc32.h from its own crc32.c main instead. */
#include <stdio.h>
#include <string.h>
#include "zlib.h"
void makefixed(void);
int main(int argc, char **argv) {
    FILE *f;
    if (argc != 2) return 1;
    if (!strcmp(argv[1],"trees.h")) {
        z_stream stream = {0};
        if (deflateInit(&stream,Z_DEFAULT_COMPRESSION)!=Z_OK) return 3;
        if (deflateEnd(&stream)!=Z_OK) return 4;
    } else if (!strcmp(argv[1],"inffixed.h")) {
        if (!freopen("inffixed.h","w",stdout)) return 5;
        makefixed();
        if (fclose(stdout)) return 6;
    } else return 7;
    f = fopen(argv[1],"r");
    if (!f) return 8;
    if (fgetc(f)==EOF) return 9;
    return fclose(f)!=0;
}
