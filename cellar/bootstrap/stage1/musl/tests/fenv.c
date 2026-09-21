/* SPDX-FileCopyrightText: © 2026 Austin Seipp
 * SPDX-License-Identifier: MIT */
#include <fenv.h>
#include <setjmp.h>
#include <signal.h>

int main(void)
{
    fenv_t env;
    sigset_t mask, saved;
    sigjmp_buf jump;
    volatile int value;
    if (fegetenv(&env)) return 1;
    if (fesetround(FE_DOWNWARD) || fegetround() != FE_DOWNWARD) return 2;
    if (fesetround(FE_UPWARD) || fegetround() != FE_UPWARD) return 3;
    if (feclearexcept(FE_ALL_EXCEPT) || fetestexcept(FE_ALL_EXCEPT)) return 4;
    if (feraiseexcept(FE_INVALID) || !(fetestexcept(FE_ALL_EXCEPT) & FE_INVALID)) return 5;
    if (fesetenv(&env) || fegetround() != FE_TONEAREST) return 6;
    sigemptyset(&mask);
    sigaddset(&mask, SIGUSR1);
    if (sigprocmask(SIG_BLOCK, &mask, &saved)) return 7;
    value = sigsetjmp(jump, 1);
    if (!value) {
        if (sigprocmask(SIG_UNBLOCK, &mask, 0)) return 8;
        siglongjmp(jump, 23);
    }
    if (value != 23 || sigprocmask(SIG_SETMASK, 0, &mask)) return 9;
    if (!sigismember(&mask, SIGUSR1)) return 10;
    return sigprocmask(SIG_SETMASK, &saved, 0) != 0;
}
