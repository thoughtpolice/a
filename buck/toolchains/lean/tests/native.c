// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

#include <lean/lean.h>

LEAN_EXPORT uint32_t depot_lean_mul_add(uint32_t a, uint32_t b, uint32_t c) {
  return a * b + c;
}
