// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// Decimal and hexadecimal text to double, correctly rounded. Short decimals
// convert with one exact floating-point operation; everything else starts
// from an estimate and moves it to the neighbour the exact value rounds to,
// comparing the two as integers.
#include <errno.h>
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "bigint.h"
#include "internal.h"

// More digits than this cannot change which double a decimal rounds to; the
// rest only matter as "something nonzero follows".
#define MAX_DIGITS 800

#define MANTISSA_BITS 52
#define IMPLICIT_BIT ((uint64_t)1 << MANTISSA_BITS)
#define MANTISSA_MASK (IMPLICIT_BIT - 1)
#define MIN_EXPONENT (-1074)
#define MAX_EXPONENT 971

static const double powers_of_ten[] = {
    1e0,  1e1,  1e2,  1e3,  1e4,  1e5,  1e6,  1e7,  1e8,  1e9,  1e10, 1e11,
    1e12, 1e13, 1e14, 1e15, 1e16, 1e17, 1e18, 1e19, 1e20, 1e21, 1e22,
};

static bool is_space(char c) {
  return c == ' ' || c == '\t' || c == '\n' || c == '\v' || c == '\f' || c == '\r';
}

static int lower(int c) {
  return c >= 'A' && c <= 'Z' ? c + ('a' - 'A') : c;
}

static bool starts_with(const char* text, const char* word, const char** end) {
  size_t i = 0;
  while (word[i]) {
    if (lower(text[i]) != word[i]) return false;
    i++;
  }
  *end = text + i;
  return true;
}

static double from_bits(uint64_t bits) {
  union {
    uint64_t bits;
    double f;
  } u = {bits};
  return u.f;
}

static uint64_t to_bits(double value) {
  union {
    double f;
    uint64_t bits;
  } u = {value};
  return u.bits;
}

static double signed_result(uint64_t bits, bool negative) {
  return from_bits(bits | ((uint64_t)negative << 63));
}

static double infinity(bool negative) {
  errno = ERANGE;
  return signed_result(0x7ff0000000000000ull, negative);
}

// Builds the double for significand * 2^exponent, where a normal significand
// has its bit 52 set and a subnormal one sits at the minimum exponent.
static double assemble(uint64_t significand, int exponent, bool negative, bool nonzero_input) {
  uint64_t bits;
  if (significand == 0) {
    bits = 0;
  } else if (significand < IMPLICIT_BIT) {
    bits = significand;
  } else {
    uint64_t biased = (uint64_t)(exponent + 1075);
    if (biased >= 0x7ff) return infinity(negative);
    bits = (biased << MANTISSA_BITS) | (significand & MANTISSA_MASK);
  }
  if (nonzero_input && significand < IMPLICIT_BIT) errno = ERANGE;
  return signed_result(bits, negative);
}

typedef struct {
  char digits[MAX_DIGITS];
  int count;
  int exponent;
  bool sticky;
} decimal;

static const char* parse_decimal(const char* p, decimal* d, bool* any_digits) {
  d->count = 0;
  d->exponent = 0;
  d->sticky = false;
  *any_digits = false;
  bool seen_point = false;
  for (;; p++) {
    char c = *p;
    if (c == '.' && !seen_point) {
      seen_point = true;
      continue;
    }
    if (c < '0' || c > '9') break;
    *any_digits = true;
    if (d->count == 0 && c == '0') {
      if (seen_point) d->exponent--;
    } else if (d->count < MAX_DIGITS) {
      d->digits[d->count++] = c;
      if (seen_point) d->exponent--;
    } else {
      if (!seen_point) d->exponent++;
      if (c != '0') d->sticky = true;
    }
  }
  if (*any_digits && (*p == 'e' || *p == 'E')) {
    const char* q = p + 1;
    bool negative = false;
    if (*q == '+' || *q == '-') negative = *q++ == '-';
    if (*q >= '0' && *q <= '9') {
      int value = 0;
      while (*q >= '0' && *q <= '9') {
        if (value < 100000) value = value * 10 + (*q - '0');
        q++;
      }
      d->exponent += negative ? -value : value;
      p = q;
    }
  }
  while (d->count > 0 && d->digits[d->count - 1] == '0') {
    d->count--;
    d->exponent++;
  }
  return p;
}

static void decimal_to_bigint(const decimal* d, console_bigint* value) {
  console_bigint_set(value, 0);
  int i = 0;
  while (i < d->count) {
    uint32_t chunk = 0;
    uint32_t scale = 1;
    for (int j = 0; j < 9 && i < d->count; j++, i++) {
      chunk = chunk * 10 + (uint32_t)(d->digits[i] - '0');
      scale *= 10;
    }
    console_bigint_multiply_small(value, scale);
    console_bigint_add_small(value, chunk);
  }
}

static double estimate(const decimal* d) {
  uint64_t leading = 0;
  int used = d->count < 19 ? d->count : 19;
  for (int i = 0; i < used; i++) leading = leading * 10 + (uint64_t)(d->digits[i] - '0');
  double value = (double)leading;
  int exponent = d->exponent + (d->count - used);
  while (exponent > 0) {
    int step = exponent < 22 ? exponent : 22;
    value *= powers_of_ten[step];
    exponent -= step;
    if (to_bits(value) >= 0x7ff0000000000000ull) break;
  }
  while (exponent < 0 && value != 0) {
    int step = -exponent < 22 ? -exponent : 22;
    value /= powers_of_ten[step];
    exponent += step;
  }
  return value;
}

static double convert_decimal(const decimal* d, bool negative) {
  if (d->count == 0) return signed_result(0, negative);
  int magnitude = d->count + d->exponent;
  if (magnitude > 310) return infinity(negative);
  if (magnitude < -330) {
    errno = ERANGE;
    return signed_result(0, negative);
  }
  if (d->count <= 19 && !d->sticky && d->exponent >= -22 && d->exponent <= 22) {
    uint64_t m = 0;
    for (int i = 0; i < d->count; i++) m = m * 10 + (uint64_t)(d->digits[i] - '0');
    if (m <= ((uint64_t)1 << 53)) {
      double value = d->exponent < 0 ? (double)m / powers_of_ten[-d->exponent]
                                     : (double)m * powers_of_ten[d->exponent];
      return signed_result(to_bits(value), negative);
    }
  }

  uint64_t bits = to_bits(estimate(d));
  uint64_t significand;
  int exponent;
  if (bits >= 0x7ff0000000000000ull) {
    significand = (IMPLICIT_BIT << 1) - 1;
    exponent = MAX_EXPONENT;
  } else if ((bits >> MANTISSA_BITS) == 0) {
    significand = bits;
    exponent = MIN_EXPONENT;
  } else {
    significand = (bits & MANTISSA_MASK) | IMPLICIT_BIT;
    exponent = (int)(bits >> MANTISSA_BITS) - 1075;
  }

  console_bigint value;
  decimal_to_bigint(d, &value);
  int decimal_up = d->exponent > 0 ? d->exponent : 0;
  int decimal_down = d->exponent < 0 ? -d->exponent : 0;
  for (int iteration = 0; iteration < 256; iteration++) {
    int binary_up = exponent > 0 ? exponent : 0;
    int binary_down = exponent < 0 ? -exponent : 0;
    console_bigint left = value;
    console_bigint_multiply_pow10(&left, decimal_up);
    console_bigint_shift_left(&left, binary_down);
    console_bigint right;
    console_bigint_set(&right, significand);
    console_bigint_shift_left(&right, binary_up);
    console_bigint_multiply_pow10(&right, decimal_down);
    console_bigint unit;
    console_bigint_set(&unit, 1);
    console_bigint_shift_left(&unit, binary_up);
    console_bigint_multiply_pow10(&unit, decimal_down);
    int order = console_bigint_compare(&left, &right);
    if (order == 0) break;
    if (order > 0) {
      console_bigint_subtract(&left, &right);
      console_bigint_shift_left(&left, 1);
      int gap = console_bigint_compare(&left, &unit);
      if (gap < 0 || (gap == 0 && !(significand & 1))) break;
      if (++significand == (IMPLICIT_BIT << 1)) {
        significand = IMPLICIT_BIT;
        if (++exponent > MAX_EXPONENT) return infinity(negative);
      }
    } else {
      bool lower_binade = significand == IMPLICIT_BIT && exponent > MIN_EXPONENT;
      console_bigint_subtract(&right, &left);
      console_bigint_shift_left(&right, lower_binade ? 2 : 1);
      int gap = console_bigint_compare(&right, &unit);
      if (gap < 0 || (gap == 0 && (lower_binade || !(significand & 1)))) break;
      if (lower_binade) {
        significand = (IMPLICIT_BIT << 1) - 1;
        exponent--;
      } else {
        significand--;
      }
    }
  }
  return assemble(significand, exponent, negative, true);
}

static int hex_digit(char c) {
  if (c >= '0' && c <= '9') return c - '0';
  if (c >= 'a' && c <= 'f') return c - 'a' + 10;
  if (c >= 'A' && c <= 'F') return c - 'A' + 10;
  return -1;
}

static bool parse_hex(const char* p, const char** end, bool negative, double* result) {
  uint64_t m = 0;
  int exponent = 0;
  bool sticky = false;
  bool seen_point = false;
  bool any = false;
  for (;; p++) {
    if (*p == '.' && !seen_point) {
      seen_point = true;
      continue;
    }
    int digit = hex_digit(*p);
    if (digit < 0) break;
    any = true;
    if (m >> 60) {
      if (digit) sticky = true;
      if (!seen_point) exponent += 4;
    } else {
      m = (m << 4) | (uint64_t)digit;
      if (seen_point) exponent -= 4;
    }
  }
  if (!any) return false;
  if (*p == 'p' || *p == 'P') {
    const char* q = p + 1;
    bool exponent_negative = false;
    if (*q == '+' || *q == '-') exponent_negative = *q++ == '-';
    if (*q >= '0' && *q <= '9') {
      int value = 0;
      while (*q >= '0' && *q <= '9') {
        if (value < 100000) value = value * 10 + (*q - '0');
        q++;
      }
      exponent += exponent_negative ? -value : value;
      p = q;
    }
  }
  *end = p;
  if (m == 0) {
    *result = signed_result(0, negative);
    return true;
  }
  int leading_zeros = __builtin_clzll(m);
  m <<= leading_zeros;
  exponent -= leading_zeros;
  int top = exponent + 63;
  if (top > 1023) {
    *result = infinity(negative);
    return true;
  }
  int shift = 11;
  if (top < -1022) shift += -1022 - top;
  if (shift > 64) {
    errno = ERANGE;
    *result = signed_result(0, negative);
    return true;
  }
  uint64_t mantissa;
  bool round_up;
  if (shift == 64) {
    mantissa = 0;
    round_up = m > ((uint64_t)1 << 63) || sticky;
  } else {
    mantissa = m >> shift;
    uint64_t remainder = m & (((uint64_t)1 << shift) - 1);
    uint64_t half = (uint64_t)1 << (shift - 1);
    round_up = remainder > half || (remainder == half && (sticky || (mantissa & 1)));
  }
  if (round_up) mantissa++;
  if (top < -1022) {
    *result = assemble(mantissa, MIN_EXPONENT, negative, true);
  } else {
    if (mantissa == (IMPLICIT_BIT << 1)) {
      mantissa = IMPLICIT_BIT;
      top++;
    }
    *result = assemble(mantissa, top - 52, negative, true);
  }
  return true;
}

double console_libc_strtod(const char* text, char** end) {
  const char* p = text;
  while (is_space(*p)) p++;
  bool negative = false;
  if (*p == '+' || *p == '-') negative = *p++ == '-';
  const char* after;
  if (starts_with(p, "infinity", &after) || starts_with(p, "inf", &after)) {
    if (end) *end = (char*)after;
    return signed_result(0x7ff0000000000000ull, negative);
  }
  if (starts_with(p, "nan", &after)) {
    if (*after == '(') {
      const char* q = after + 1;
      while ((*q >= '0' && *q <= '9') || (lower(*q) >= 'a' && lower(*q) <= 'z') || *q == '_') q++;
      if (*q == ')') after = q + 1;
    }
    if (end) *end = (char*)after;
    return signed_result(0x7ff8000000000000ull, negative);
  }
  if (*p == '0' && (p[1] == 'x' || p[1] == 'X')) {
    double result;
    if (parse_hex(p + 2, &after, negative, &result)) {
      if (end) *end = (char*)after;
      return result;
    }
  }
  decimal d;
  bool any_digits;
  after = parse_decimal(p, &d, &any_digits);
  if (!any_digits) {
    if (end) *end = (char*)text;
    return 0.0;
  }
  if (end) *end = (char*)after;
  return convert_decimal(&d, negative);
}

#ifndef CONSOLE_LIBC_NATIVE_TEST
double strtod(const char* text, char** end) {
  return console_libc_strtod(text, end);
}

double atof(const char* text) {
  return console_libc_strtod(text, NULL);
}
#endif
