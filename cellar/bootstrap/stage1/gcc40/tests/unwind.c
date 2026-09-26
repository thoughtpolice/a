/* SPDX-FileCopyrightText: 2026 Austin Seipp
 * SPDX-License-Identifier: MIT */
#include <unwind.h>
#include <pthread.h>
#include <setjmp.h>
#include <signal.h>
#include <stdlib.h>
#include <stdio.h>
#include <unistd.h>

static __thread int frames;
static __thread int cleaned;
static __thread jmp_buf escape;
static __thread struct _Unwind_Exception exception;
static volatile sig_atomic_t signal_frames;
static _Unwind_Reason_Code visit(struct _Unwind_Context *context, void *data)
{
    int *count = data;
    if (_Unwind_GetIP(context)) ++*count;
    return _URC_NO_REASON;
}
static void __attribute__((noinline)) trace(void)
{
    frames = 0;
    _Unwind_Backtrace(visit, &frames);
    if (frames < 3) { fprintf(stderr, "trace frames: %d\n", frames); exit(10); }
}
static void release(int *p) { cleaned += *p; }
static _Unwind_Reason_Code stop(int version, _Unwind_Action actions,
    _Unwind_Exception_Class cls, struct _Unwind_Exception *object,
    struct _Unwind_Context *context, void *arg)
{
    if (version != 1 || !(actions & _UA_FORCE_UNWIND)) exit(11);
    if (cleaned == 7) longjmp(escape, 1);
    if (actions & _UA_END_OF_STACK) { fprintf(stderr, "end of stack, cleaned: %d\n", cleaned); exit(12); }
    return _URC_NO_REASON;
}
static void __attribute__((noinline)) force(void)
{
    int value __attribute__((cleanup(release))) = 7;
    _Unwind_ForcedUnwind(&exception, stop, 0);
    exit(13);
}
static void *worker(void *arg)
{
    int i;
    for (i = 0; i < 20; ++i) trace();
    cleaned = 0;
    if (!setjmp(escape)) force();
    return cleaned == 7 ? 0 : (void *)1;
}
static void handler(int sig)
{
    int count = 0;
    _Unwind_Backtrace(visit, &count);
    signal_frames = count;
}
static void __attribute__((noinline)) signal_test(void)
{
    struct sigaction sa = {0};
    long result;
    sa.sa_handler = handler;
    sigemptyset(&sa.sa_mask);
    if (sigaction(SIGUSR1, &sa, 0)) exit(14);
    /* Interrupt this GCC frame directly: predecessor libc has no DWARF
       unwind tables for raise(). This exercises the signal-frame fallback. */
    __asm__ volatile ("syscall" : "=a" (result)
        : "0" (62L), "D" ((long)getpid()), "S" ((long)SIGUSR1)
        : "rcx", "r11", "memory");
    if (result || signal_frames < 4) { fprintf(stderr, "signal frames: %d\n", signal_frames); exit(15); }
}
int main(void)
{
    pthread_t a, b;
    void *result;
    alarm(10);
    trace();
    signal_test();
    if (pthread_create(&a, 0, worker, 0) || pthread_create(&b, 0, worker, 0)) return 1;
    if (pthread_join(a, &result) || result) return 2;
    if (pthread_join(b, &result) || result) return 3;
    return 0;
}
