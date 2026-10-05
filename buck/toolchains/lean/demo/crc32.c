// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// Framelog.Crc32.fast, a table-driven CRC-32 (IEEE 802.3, reflected).

#include <lean/lean.h>
#include <stdint.h>

static uint32_t table[256];

// Runs when the program starts, and when lean loads a precompiled Lean
// library holding this code.
__attribute__((constructor)) static void framelog_crc32_table(void) {
  for (uint32_t i = 0; i < 256; i++) {
    uint32_t c = i;
    for (int k = 0; k < 8; k++) {
      c = (c & 1) ? (c >> 1) ^ 0xEDB88320u : c >> 1;
    }
    table[i] = c;
  }
}

LEAN_EXPORT uint32_t framelog_crc32(b_lean_obj_arg data) {
  const uint8_t* p = lean_sarray_cptr(data);
  size_t n = lean_sarray_size(data);
  uint32_t c = 0xFFFFFFFFu;
  for (size_t i = 0; i < n; i++) {
    c = table[(c ^ p[i]) & 0xFF] ^ (c >> 8);
  }
  return ~c;
}
