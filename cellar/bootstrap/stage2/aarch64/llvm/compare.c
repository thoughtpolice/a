// SPDX-FileCopyrightText: 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

#include <stdio.h>
#include <string.h>

int main(int argc, char **argv) {
    if (argc < 4 || argc % 2) return 2;
    for (int i = 1; i < argc - 1; i += 2) {
        FILE *left = fopen(argv[i], "rb"), *right = fopen(argv[i + 1], "rb");
        if (!left || !right) { perror("comparison input"); return 1; }
        unsigned char a[65536], b[65536];
        for (;;) {
            size_t na = fread(a, 1, sizeof a, left), nb = fread(b, 1, sizeof b, right);
            if (ferror(left) || ferror(right) || na != nb || memcmp(a, b, na)) {
                fprintf(stderr, "fixed point differs: %s and %s\n", argv[i], argv[i + 1]);
                return 1;
            }
            if (!na) break;
        }
        fclose(left);
        fclose(right);
    }
    FILE *out = fopen(argv[argc - 1], "w");
    if (!out || fputs("passed\n", out) < 0 || fclose(out)) return 1;
    return 0;
}
