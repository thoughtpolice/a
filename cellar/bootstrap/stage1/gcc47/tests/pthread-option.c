/* SPDX-FileCopyrightText: 2026 Austin Seipp
 * SPDX-License-Identifier: Apache-2.0 */
#ifndef _REENTRANT
#error -pthread must select the native preprocessor specification
#endif
#include <pthread.h>
static void *worker(void *value) { return value; }
int main(void)
{
    pthread_t thread;
    void *value;
    int marker;
    return pthread_create(&thread, 0, worker, &marker) ||
           pthread_join(thread, &value) || value != &marker;
}
