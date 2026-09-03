// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

#include "bigint.h"

static void trim(console_bigint* value) {
  while (value->length > 0 && value->limb[value->length - 1] == 0) value->length--;
}

static void require_room(int limbs) {
  if (limbs > CONSOLE_BIGINT_LIMBS) __builtin_trap();
}

void console_bigint_set(console_bigint* value, uint64_t initial) {
  value->limb[0] = (uint32_t)initial;
  value->limb[1] = (uint32_t)(initial >> 32);
  value->length = 2;
  trim(value);
}

bool console_bigint_is_zero(const console_bigint* value) {
  return value->length == 0;
}

void console_bigint_add(console_bigint* value, const console_bigint* addend) {
  int length = value->length > addend->length ? value->length : addend->length;
  require_room(length + 1);
  uint64_t carry = 0;
  for (int i = 0; i < length; i++) {
    uint64_t sum = carry;
    if (i < value->length) sum += value->limb[i];
    if (i < addend->length) sum += addend->limb[i];
    value->limb[i] = (uint32_t)sum;
    carry = sum >> 32;
  }
  value->length = length;
  if (carry) value->limb[value->length++] = (uint32_t)carry;
}

void console_bigint_subtract(console_bigint* value, const console_bigint* subtrahend) {
  int64_t borrow = 0;
  for (int i = 0; i < value->length; i++) {
    int64_t difference = (int64_t)value->limb[i] - borrow;
    if (i < subtrahend->length) difference -= subtrahend->limb[i];
    borrow = 0;
    if (difference < 0) {
      difference += (int64_t)1 << 32;
      borrow = 1;
    }
    value->limb[i] = (uint32_t)difference;
  }
  trim(value);
}

void console_bigint_add_small(console_bigint* value, uint32_t addend) {
  uint64_t carry = addend;
  for (int i = 0; i < value->length && carry; i++) {
    uint64_t sum = (uint64_t)value->limb[i] + carry;
    value->limb[i] = (uint32_t)sum;
    carry = sum >> 32;
  }
  if (carry) {
    require_room(value->length + 1);
    value->limb[value->length++] = (uint32_t)carry;
  }
}

void console_bigint_multiply_small(console_bigint* value, uint32_t factor) {
  uint64_t carry = 0;
  for (int i = 0; i < value->length; i++) {
    uint64_t product = (uint64_t)value->limb[i] * factor + carry;
    value->limb[i] = (uint32_t)product;
    carry = product >> 32;
  }
  if (carry) {
    require_room(value->length + 1);
    value->limb[value->length++] = (uint32_t)carry;
  }
  if (factor == 0) value->length = 0;
}

void console_bigint_multiply_pow10(console_bigint* value, int exponent) {
  while (exponent >= 9) {
    console_bigint_multiply_small(value, 1000000000u);
    exponent -= 9;
  }
  while (exponent-- > 0) console_bigint_multiply_small(value, 10);
}

uint32_t console_bigint_divide_small(console_bigint* value, uint32_t divisor) {
  uint64_t remainder = 0;
  for (int i = value->length; i-- > 0;) {
    uint64_t current = (remainder << 32) | value->limb[i];
    value->limb[i] = (uint32_t)(current / divisor);
    remainder = current % divisor;
  }
  trim(value);
  return (uint32_t)remainder;
}

void console_bigint_shift_left(console_bigint* value, int bits) {
  if (value->length == 0 || bits == 0) return;
  int limbs = bits / 32;
  int remainder = bits % 32;
  require_room(value->length + limbs + 1);
  if (remainder) {
    uint32_t carry = 0;
    for (int i = 0; i < value->length; i++) {
      uint32_t current = value->limb[i];
      value->limb[i] = (current << remainder) | carry;
      carry = current >> (32 - remainder);
    }
    if (carry) value->limb[value->length++] = carry;
  }
  if (limbs) {
    for (int i = value->length; i-- > 0;) value->limb[i + limbs] = value->limb[i];
    for (int i = 0; i < limbs; i++) value->limb[i] = 0;
    value->length += limbs;
  }
}

int console_bigint_compare(const console_bigint* left, const console_bigint* right) {
  if (left->length != right->length) return left->length < right->length ? -1 : 1;
  for (int i = left->length; i-- > 0;) {
    if (left->limb[i] != right->limb[i]) return left->limb[i] < right->limb[i] ? -1 : 1;
  }
  return 0;
}

int console_bigint_bit_length(const console_bigint* value) {
  if (value->length == 0) return 0;
  uint32_t top = value->limb[value->length - 1];
  int bits = 0;
  while (top) {
    bits++;
    top >>= 1;
  }
  return (value->length - 1) * 32 + bits;
}

uint32_t console_bigint_extract_high(console_bigint* value, int bits) {
  int limbs = bits / 32;
  int remainder = bits % 32;
  uint64_t high = 0;
  if (limbs < value->length) {
    high = (uint64_t)value->limb[limbs] >> remainder;
    if (limbs + 1 < value->length) high |= (uint64_t)value->limb[limbs + 1] << (32 - remainder);
    if (remainder) {
      value->limb[limbs] &= ((uint32_t)1 << remainder) - 1;
      value->length = limbs + 1;
    } else {
      value->length = limbs;
    }
    trim(value);
  }
  return (uint32_t)high;
}

int console_bigint_compare_pow2(const console_bigint* value, int exponent) {
  int length = console_bigint_bit_length(value);
  if (length != exponent + 1) return length < exponent + 1 ? -1 : 1;
  for (int i = 0; i < value->length - 1; i++) {
    if (value->limb[i]) return 1;
  }
  uint32_t top = value->limb[value->length - 1];
  return (top & (top - 1)) ? 1 : 0;
}
