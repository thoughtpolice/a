/* SPDX-FileCopyrightText: 2026 Austin Seipp
 * SPDX-License-Identifier: MIT */
#define _GNU_SOURCE
#include <stdlib.h>
#include <stdint.h>
#include <string.h>
#include <malloc.h>

int main(void)
{
    unsigned char *p[96], *q;
    size_t sizes[96], i, j, n;
    for (i=0; i<96; ++i) {
        n = sizes[i] = 1 + i*i*23;
        p[i] = calloc(1, n);
        if (!p[i] || (uintptr_t)p[i] % 16) return 1;
        for (j=0; j<n; ++j) if (p[i][j]) return 2;
        memset(p[i], (int)i, n);
    }
    for (i=0; i<96; ++i) {
        n = sizes[i];
        q = realloc(p[i], n*2+37);
        if (!q || malloc_usable_size(q) < n*2+37) return 3;
        for (j=0; j<n; ++j) if (q[j] != i) return 4;
        free(q);
    }
    for (i=16; i<=65536; i*=2) {
        if (posix_memalign((void **)&q, i, i+17) || (uintptr_t)q % i) return 5;
        memset(q, 0x5a, i+17);
        free(q);
    }
    return 0;
}
