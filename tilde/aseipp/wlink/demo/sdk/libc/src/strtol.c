// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

#include <errno.h>
#include <limits.h>
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "internal.h"

static bool is_space(char c) {
  return c == ' ' || c == '\t' || c == '\n' || c == '\v' || c == '\f' || c == '\r';
}

static int digit_value(char c) {
  if (c >= '0' && c <= '9') return c - '0';
  if (c >= 'a' && c <= 'z') return c - 'a' + 10;
  if (c >= 'A' && c <= 'Z') return c - 'A' + 10;
  return 36;
}

// Parses sign, prefix, and digits; the magnitude saturates at limit with
// overflow reported separately so the callers can clamp per their type.
static uintmax_t parse_magnitude(const char* text, const char** end, int base, bool* negative,
                                 bool* overflow, uintmax_t limit) {
  const char* p = text;
  *negative = false;
  *overflow = false;
  if (base < 0 || base == 1 || base > 36) {
    errno = EINVAL;
    *end = text;
    return 0;
  }
  while (is_space(*p)) p++;
  if (*p == '+' || *p == '-') *negative = *p++ == '-';
  if ((base == 0 || base == 16) && p[0] == '0' && (p[1] == 'x' || p[1] == 'X') &&
      digit_value(p[2]) < 16) {
    p += 2;
    base = 16;
  } else if (base == 0) {
    base = *p == '0' ? 8 : 10;
  }
  const char* digits = p;
  uintmax_t value = 0;
  for (;; p++) {
    int digit = digit_value(*p);
    if (digit >= base) break;
    if (value > (limit - (uintmax_t)digit) / (uintmax_t)base) {
      *overflow = true;
      value = limit;
    } else if (!*overflow) {
      value = value * (uintmax_t)base + (uintmax_t)digit;
    }
  }
  *end = p == digits ? text : p;
  if (p == digits) *negative = false;
  return value;
}

unsigned long console_libc_strtoul(const char* text, char** end, int base) {
  bool negative;
  bool overflow;
  const char* stop;
  uintmax_t value = parse_magnitude(text, &stop, base, &negative, &overflow, ULONG_MAX);
  if (end) *end = (char*)stop;
  if (overflow) {
    errno = ERANGE;
    return ULONG_MAX;
  }
  return negative ? (unsigned long)0 - (unsigned long)value : (unsigned long)value;
}

long console_libc_strtol(const char* text, char** end, int base) {
  bool negative;
  bool overflow;
  const char* stop;
  uintmax_t value = parse_magnitude(text, &stop, base, &negative, &overflow,
                                    (uintmax_t)LONG_MAX + 1);
  if (end) *end = (char*)stop;
  if (overflow || (!negative && value > (uintmax_t)LONG_MAX)) {
    errno = ERANGE;
    return negative ? LONG_MIN : LONG_MAX;
  }
  return negative ? (long)(0 - value) : (long)value;
}

unsigned long long console_libc_strtoull(const char* text, char** end, int base) {
  bool negative;
  bool overflow;
  const char* stop;
  uintmax_t value = parse_magnitude(text, &stop, base, &negative, &overflow, ULLONG_MAX);
  if (end) *end = (char*)stop;
  if (overflow) {
    errno = ERANGE;
    return ULLONG_MAX;
  }
  return negative ? (unsigned long long)0 - (unsigned long long)value
                  : (unsigned long long)value;
}

long long console_libc_strtoll(const char* text, char** end, int base) {
  bool negative;
  bool overflow;
  const char* stop;
  uintmax_t value = parse_magnitude(text, &stop, base, &negative, &overflow,
                                    (uintmax_t)LLONG_MAX + 1);
  if (end) *end = (char*)stop;
  if (overflow || (!negative && value > (uintmax_t)LLONG_MAX)) {
    errno = ERANGE;
    return negative ? LLONG_MIN : LLONG_MAX;
  }
  return negative ? (long long)(0 - value) : (long long)value;
}

#ifndef CONSOLE_LIBC_NATIVE_TEST
unsigned long strtoul(const char* text, char** end, int base) {
  return console_libc_strtoul(text, end, base);
}

long strtol(const char* text, char** end, int base) {
  return console_libc_strtol(text, end, base);
}

int atoi(const char* text) {
  return (int)console_libc_strtol(text, NULL, 10);
}

long atol(const char* text) {
  return console_libc_strtol(text, NULL, 10);
}

unsigned long long strtoull(const char* text, char** end, int base) {
  return console_libc_strtoull(text, end, base);
}

long long strtoll(const char* text, char** end, int base) {
  return console_libc_strtoll(text, end, base);
}

long long atoll(const char* text) {
  return console_libc_strtoll(text, NULL, 10);
}
#endif
