/* SPDX-FileCopyrightText: © 2026 Austin Seipp
 * SPDX-License-Identifier: Apache-2.0
 * Compare table values independently of C source formatting.
 */
#include <ctype.h>
#include <limits.h>
#include <stdio.h>
#include <string.h>

#define END (-1L)
#define BAD (-2L)

static long number(FILE *f)
{
    int c;
    long value = 0;
    do c = getc(f); while (isspace(c) || c == ',');
    if (c == EOF) return ferror(f) ? BAD : END;
    if (c < '0' || c > '9') return BAD;
    do {
        if (value > (LONG_MAX - (c - '0')) / 10) return BAD;
        value = 10 * value + c - '0';
        c = getc(f);
    } while (c >= '0' && c <= '9');
    if (c != EOF) ungetc(c, f);
    return value;
}

static long byte(FILE *f, int *quoted)
{
    int c, count, value;
    for (;;) {
        c = getc(f);
        if (c == EOF) return ferror(f) || *quoted ? BAD : END;
        if (c == '"') { *quoted = !*quoted; continue; }
        if (!*quoted) {
            if (!isspace(c)) return BAD;
            continue;
        }
        if (c != '\\') return c == '\n' ? BAD : c;
        c = getc(f);
        if (c < '0' || c > '7') return BAD;
        value = c - '0';
        for (count = 1; count < 3; count++) {
            c = getc(f);
            if (c < '0' || c > '7') {
                if (c != EOF) ungetc(c, f);
                break;
            }
            value = 8 * value + c - '0';
        }
        return value < 256 ? value : BAD;
    }
}

int main(int argc, char **argv)
{
    FILE *a, *b;
    long x, y;
    unsigned long index = 0;
    int qa = 0, qb = 0, strings;
    if (argc != 4) return 1;
    strings = !strcmp(argv[1], "strings");
    if (!strings && strcmp(argv[1], "numbers")) return 1;
    a = fopen(argv[2], "r");
    b = fopen(argv[3], "r");
    if (!a || !b) { perror("table input"); return 1; }
    for (;;) {
        x = strings ? byte(a, &qa) : number(a);
        y = strings ? byte(b, &qb) : number(b);
        if (x == BAD || y == BAD || x != y) {
            fprintf(stderr, "table value %lu: %ld != %ld\n", index, x, y);
            return 1;
        }
        if (x == END) break;
        index++;
    }
    if (!index || fclose(a) || fclose(b)) return 1;
    printf("%lu table values match\n", index);
    return 0;
}
