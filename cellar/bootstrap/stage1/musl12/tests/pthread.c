/* SPDX-FileCopyrightText: 2026 Austin Seipp
 * SPDX-License-Identifier: MIT */
#define _GNU_SOURCE
#include <errno.h>
#include <pthread.h>
#include <semaphore.h>
#include <stdlib.h>
#include <unistd.h>

static pthread_mutex_t lock = PTHREAD_MUTEX_INITIALIZER;
static pthread_mutex_t robust;
static pthread_cond_t ready = PTHREAD_COND_INITIALIZER;
static pthread_rwlock_t rw = PTHREAD_RWLOCK_INITIALIZER;
static pthread_once_t once = PTHREAD_ONCE_INIT;
static __thread int private = 17;
static int started, release, total, init_count, cleaned;
static sem_t cancellation_ready;
static void init(void) { ++init_count; }
static void *work(void *arg)
{
    int i;
    if (private != 17) return (void *)1;
    private = (long)arg;
    pthread_once(&once, init);
    pthread_mutex_lock(&lock);
    ++started;
    pthread_cond_broadcast(&ready);
    while (!release) pthread_cond_wait(&ready, &lock);
    pthread_mutex_unlock(&lock);
    for (i=0; i<200; ++i) {
        if (pthread_rwlock_wrlock(&rw)) return (void *)2;
        ++total;
        pthread_rwlock_unlock(&rw);
    }
    return private == (long)arg ? 0 : (void *)3;
}
static void *abandon(void *arg)
{
    if (pthread_mutex_lock(&robust)) return (void *)1;
    return 0;
}
static void cleanup(void *arg) { cleaned = 1; }
static void *cancelled(void *arg)
{
    pthread_cleanup_push(cleanup, 0);
    sem_post(&cancellation_ready);
    for (;;) { pthread_testcancel(); usleep(1000); }
    pthread_cleanup_pop(0);
    return 0;
}
int main(void)
{
    pthread_t a, b;
    pthread_mutexattr_t attr;
    void *result;
    alarm(10);
    if (pthread_create(&a, 0, work, (void *)31) || pthread_create(&b, 0, work, (void *)32)) return 1;
    pthread_mutex_lock(&lock);
    while (started != 2) pthread_cond_wait(&ready, &lock);
    release = 1;
    pthread_cond_broadcast(&ready);
    pthread_mutex_unlock(&lock);
    if (pthread_join(a, &result) || result || pthread_join(b, &result) || result) return 2;
    if (total != 400 || init_count != 1 || private != 17) return 3;
    if (pthread_rwlock_rdlock(&rw) || pthread_rwlock_unlock(&rw)) return 4;
    if (pthread_mutexattr_init(&attr) || pthread_mutexattr_setrobust(&attr, PTHREAD_MUTEX_ROBUST) || pthread_mutex_init(&robust, &attr)) return 5;
    pthread_mutexattr_destroy(&attr);
    if (pthread_create(&a, 0, abandon, 0) || pthread_join(a, &result) || result) return 6;
    if (pthread_mutex_lock(&robust) != EOWNERDEAD || pthread_mutex_consistent(&robust) || pthread_mutex_unlock(&robust)) return 7;
    pthread_mutex_destroy(&robust);
    if (sem_init(&cancellation_ready, 0, 0) || pthread_create(&a, 0, cancelled, 0)) return 8;
    if (sem_wait(&cancellation_ready) || pthread_cancel(a) || pthread_join(a, &result)) return 9;
    if (result != PTHREAD_CANCELED || !cleaned) return 10;
    sem_destroy(&cancellation_ready);
    return 0;
}
