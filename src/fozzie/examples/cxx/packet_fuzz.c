// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

#include "fozzie/runtime/target.h"
#include "packet.h"

int LLVMFuzzerTestOneInput(const uint8_t* data, size_t size) {
    volatile uint32_t checksum = packet_checksum(data, size);
    (void)checksum;
    return 0;
}
