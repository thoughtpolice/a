// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

#include "fozzie/runtime/target.h"

#include <stdint.h>

int LLVMFuzzerTestOneInput(const uint8_t* data, size_t size) {
    if (size != 1) {
        return 0;
    }
    if (data[0] == 'U') {
        volatile uint8_t underflow = data[-1];
        (void)underflow;
    }
    if (data[0] == 'O') {
        volatile uint8_t overflow = data[size];
        (void)overflow;
    }
    return 0;
}
