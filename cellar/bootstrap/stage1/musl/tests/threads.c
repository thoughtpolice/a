/* SPDX-FileCopyrightText: © 2026 Austin Seipp
 * SPDX-License-Identifier: MIT */
#include <errno.h>
#include <pthread.h>
#include <stdlib.h>
#include <unistd.h>

static pthread_mutex_t lock = PTHREAD_MUTEX_INITIALIZER;
static int count;
static int *main_errno;

static void *worker(void *arg)
{
    int i;
    char *p;
    if (&errno == main_errno) return (void *)1;
    errno = (long)arg;
    for (i = 0; i < 100; i++) {
        p = malloc(32 + i);
        if (!p) return (void *)2;
        p[i] = 7;
        if (pthread_mutex_lock(&lock)) return (void *)3;
        count++;
        if (pthread_mutex_unlock(&lock)) return (void *)4;
        free(p);
    }
    if (errno != (long)arg) return (void *)5;
    return 0;
}

int main(void)
{
    pthread_t a, b;
    void *status;
    alarm(10);
    main_errno = &errno;
    errno = 77;
    if (pthread_create(&a, 0, worker, (void *)31)) return 1;
    if (pthread_create(&b, 0, worker, (void *)32)) return 2;
    if (pthread_join(a, &status) || status) return 3;
    if (pthread_join(b, &status) || status) return 4;
    if (count != 200 || errno != 77) return 5;
    return 0;
}
