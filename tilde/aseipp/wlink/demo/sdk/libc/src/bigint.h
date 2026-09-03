// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

#ifndef CONSOLE_LIBC_BIGINT_H
#define CONSOLE_LIBC_BIGINT_H

#include <stdbool.h>
#include <stdint.h>

// Unsigned integers wide enough for exact conversions between doubles and
// decimal text: an 800-digit decimal scaled by the largest binary and decimal
// exponents strtod compares stays under 5,000 bits.
#define CONSOLE_BIGINT_LIMBS 192

typedef struct {
  uint32_t limb[CONSOLE_BIGINT_LIMBS];
  int length;
} console_bigint;

void console_bigint_set(console_bigint* value, uint64_t initial);
bool console_bigint_is_zero(const console_bigint* value);
void console_bigint_add(console_bigint* value, const console_bigint* addend);
// The subtrahend must not exceed the value.
void console_bigint_subtract(console_bigint* value, const console_bigint* subtrahend);
void console_bigint_add_small(console_bigint* value, uint32_t addend);
void console_bigint_multiply_small(console_bigint* value, uint32_t factor);
void console_bigint_multiply_pow10(console_bigint* value, int exponent);
// Returns the remainder.
uint32_t console_bigint_divide_small(console_bigint* value, uint32_t divisor);
void console_bigint_shift_left(console_bigint* value, int bits);
int console_bigint_compare(const console_bigint* left, const console_bigint* right);
int console_bigint_bit_length(const console_bigint* value);
// Removes and returns the bits at and above the given position, which must
// fit in 32 bits; the value keeps its low bits.
uint32_t console_bigint_extract_high(console_bigint* value, int bits);
// Compares the value with 2 to the given power.
int console_bigint_compare_pow2(const console_bigint* value, int exponent);

#endif
