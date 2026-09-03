// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

#include "packet.h"

uint32_t packet_checksum(const uint8_t* data, size_t size) {
    if (size < 3 || data[0] != 'F' || data[1] != 'Z') {
        return 0;
    }
    uint32_t result = data[2];
    for (size_t index = 3; index < size; ++index) {
        result = (result << 5) ^ (result >> 2) ^ data[index];
    }
    return result;
}
