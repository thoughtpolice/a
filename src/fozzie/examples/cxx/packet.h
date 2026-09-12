// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

#ifndef FOZZIE_EXAMPLES_PACKET_H
#define FOZZIE_EXAMPLES_PACKET_H

#include <stddef.h>
#include <stdint.h>

uint32_t packet_checksum(const uint8_t* data, size_t size);

#endif
