/* SPDX-FileCopyrightText: © 2026 Austin Seipp
 * SPDX-License-Identifier: Apache-2.0
 *
 * A static program linked with mimalloc.o gets its memory from mimalloc, on
 * every thread, through the C allocation interface.
 */
#include <mimalloc.h>
#include <pthread.h>
#include <stdlib.h>
#include <string.h>

static void *allocate(void *unused)
{
    char *p = malloc(4096);
    (void)unused;
    if (!p || !mi_is_in_heap_region(p)) return (void *)1;
    memset(p, 'x', 4096);
    free(p);
    return 0;
}

int main(void)
{
    char *p = malloc(100), *q;
    int *zero;
    pthread_t thread;
    void *result;
    size_t i;
    if (!p || !mi_is_in_heap_region(p)) return 1;
    memset(p, 'x', 100);
    q = realloc(p, 1 << 20);
    if (!q || q[99] != 'x' || !mi_is_in_heap_region(q)) return 2;
    free(q);
    zero = calloc(1000, sizeof *zero);
    if (!zero || !mi_is_in_heap_region(zero)) return 3;
    for (i = 0; i < 1000; i++) if (zero[i]) return 4;
    free(zero);
    if (pthread_create(&thread, 0, allocate, 0) || pthread_join(thread, &result) || result) return 5;
    return 0;
}
