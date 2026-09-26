/* SPDX-FileCopyrightText: © 2026 Austin Seipp
 * SPDX-License-Identifier: Apache-2.0
 *
 * The two ordering pipelines in musl-chartable-tools/iconv/Makefile.
 * Inputs are pinned Unicode mapping files, never generated musl headers.
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static unsigned char legacy[65536];
struct entry { unsigned first, jis, unicode; };
static struct entry entries[12000];

static int compare(const void *a, const void *b)
{
    const struct entry *x = a, *y = b;
    if (x->unicode != y->unicode) return x->unicode < y->unicode ? -1 : 1;
    if (x->first != y->first) return x->first < y->first ? -1 : 1;
    return (x->jis > y->jis) - (x->jis < y->jis);
}

int main(int argc, char **argv)
{
    char line[1024];
    unsigned a, b, c, i, count = 0;
    FILE *f;
    int arg;
    if (argc < 3) return 1;
    if (!strcmp(argv[1], "legacy")) {
        for (arg = 2; arg < argc; arg++) {
            f = fopen(argv[arg], "r");
            if (!f) { perror(argv[arg]); return 1; }
            while (fgets(line, sizeof line, f)) {
                if (strncmp(line, "0x", 2)) continue;
                if (sscanf(line, "%x %x", &a, &b) != 2) continue;
                if (a > 255 || b > 65535) return 1;
                if (b >= 256) legacy[b] = 1;
            }
            if (ferror(f) || fclose(f)) return 1;
        }
        for (i = 256; i < 65536; i++)
            if (legacy[i]) printf("%u\n", i);
    } else if (!strcmp(argv[1], "revjis") && argc == 3) {
        f = fopen(argv[2], "r");
        if (!f) { perror(argv[2]); return 1; }
        while (fgets(line, sizeof line, f)) {
            if (strncmp(line, "0x", 2)) continue;
            if (sscanf(line, "%x %x %x", &a, &b, &c) != 3) return 1;
            if (b < 0x2121 || b > 0x7e7e || count == 12000) return 1;
            entries[count].first = a;
            entries[count].jis = b;
            entries[count++].unicode = c;
        }
        if (ferror(f) || fclose(f)) return 1;
        qsort(entries, count, sizeof entries[0], compare);
        for (i = 0; i < count; i++) printf("%u\n", entries[i].jis - 0x2121);
    } else return 1;
    return fflush(stdout) != 0;
}
