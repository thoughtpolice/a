// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// Run a loop with a timer and a threadpool job, and check the library is the
// version the package says it is.

#include <stdio.h>
#include <string.h>
#include <uv.h>

static int timer_fired, work_ran, after_work_ran;

static void on_timer(uv_timer_t *timer) {
    timer_fired++;
    uv_close((uv_handle_t *)timer, NULL);
}

static void work(uv_work_t *req) {
    (void)req;
    work_ran++;
}

static void after_work(uv_work_t *req, int status) {
    (void)req;
    if (status == 0) after_work_ran++;
}

int main(void) {
    if (strcmp(uv_version_string(), EXPECTED_VERSION) != 0)
        return fprintf(stderr, "version %s, expected %s\n", uv_version_string(), EXPECTED_VERSION), 1;

    uv_loop_t loop;
    int r = uv_loop_init(&loop);
    if (r != 0) return fprintf(stderr, "uv_loop_init: %s\n", uv_strerror(r)), 1;

    uv_timer_t timer;
    uv_timer_init(&loop, &timer);
    uv_timer_start(&timer, on_timer, 10, 0);

    uv_work_t req;
    r = uv_queue_work(&loop, &req, work, after_work);
    if (r != 0) return fprintf(stderr, "uv_queue_work: %s\n", uv_strerror(r)), 1;

    uint64_t start = uv_now(&loop);
    uv_run(&loop, UV_RUN_DEFAULT);
    if (timer_fired != 1 || work_ran != 1 || after_work_ran != 1)
        return fprintf(stderr, "timer %d, work %d, after_work %d\n", timer_fired, work_ran, after_work_ran), 1;
    if (uv_now(&loop) - start < 10)
        return fprintf(stderr, "timer fired after %llu ms\n", (unsigned long long)(uv_now(&loop) - start)), 1;

    r = uv_loop_close(&loop);
    if (r != 0) return fprintf(stderr, "uv_loop_close: %s\n", uv_strerror(r)), 1;
    return 0;
}
