// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

#include "fozzie/runtime/target.h"

#include <limits.h>
#include <string.h>

static int overflow;

int LLVMFuzzerInitialize(int* argc, char*** argv) {
    overflow = *argc > 1 && strcmp((*argv)[1], "overflow") == 0;
    return 0;
}

// Overflows a signed int only when started with the `overflow` argument,
// so the fuzz test this target also gets passes, and a replay with the
// argument checks that the address profile includes UBSan.
int LLVMFuzzerTestOneInput(const uint8_t* data, size_t size) {
    volatile int base = INT_MAX;
    volatile int step = overflow && size != 0 ? data[0] : 0;
    volatile int sum = base + step;
    (void)sum;
    return 0;
}
