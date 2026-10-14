// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// The executor fixtures crash on purpose, and fozzie asks ASan to leave core
// dumps on. Turning them off before anything else runs keeps each test run
// from leaving a core under systemd-coredump (or /cores on Darwin).

#include <sys/resource.h>

#if defined(__linux__)
#include <sys/prctl.h>
#endif

__attribute__((constructor)) static void disable_core_dumps(void) {
    struct rlimit limit = {0, 0};
    (void)setrlimit(RLIMIT_CORE, &limit);
#if defined(__linux__)
    // A zero limit still hands the crash to a piped core_pattern, which logs
    // it; a process that is not dumpable never reaches the handler.
    (void)prctl(PR_SET_DUMPABLE, 0);
#endif
}
