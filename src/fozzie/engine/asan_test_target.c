// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

#include "fozzie/runtime/target.h"

#include <stdint.h>

static volatile uint8_t* dangling;

// Leaves a pointer to its own frame behind, which ASan catches only with
// use-after-return detection on.
__attribute__((noinline)) static void leave_frame(uint8_t byte) {
    volatile uint8_t local[16];
    local[0] = byte;
    dangling = local;
}

int LLVMFuzzerTestOneInput(const uint8_t* data, size_t size) {
    if (size != 1) {
        return 0;
    }
    if (data[0] == 'U') {
        volatile uint8_t underflow = data[-1];
        (void)underflow;
    }
    if (data[0] == 'R') {
        leave_frame(data[0]);
        volatile uint8_t stale = dangling[0];
        (void)stale;
    }
    if (data[0] == 'O') {
        volatile uint8_t overflow = data[size];
        (void)overflow;
    }
    return 0;
}
