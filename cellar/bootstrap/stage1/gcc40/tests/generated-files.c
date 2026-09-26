/* SPDX-FileCopyrightText: 2026 Austin Seipp
 * SPDX-License-Identifier: Apache-2.0 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

int main(int argc, char **argv)
{
    int i;
    if (argc != 67) return 2;
    for (i = 1; i < argc; ++i) {
        FILE *f = fopen(argv[i], "rb");
        long size;
        char *text;
        if (!f || fseek(f, 0, SEEK_END) || (size = ftell(f)) < 100 ||
            fseek(f, 0, SEEK_SET)) return 1;
        text = malloc(size + 1);
        if (!text || fread(text, 1, size, f) != size || fclose(f)) return 1;
        text[size] = 0;
        if (strlen(text) != size || strstr(text, "buck-out/") ||
            strstr(text, "/home/") || strstr(text, "/tmp/")) {
            fprintf(stderr, "invalid generated source: %s\n", argv[i]);
            return 1;
        }
        free(text);
    }
    return 0;
}
