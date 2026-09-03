// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// sscanf: the numeric, string, character, and scanset conversions with
// widths, assignment suppression, and the integer length modifiers.
#include <stdarg.h>
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "internal.h"

#define FIELD_LIMIT 1024

enum modifier {
  MODIFIER_NONE,
  MODIFIER_CHAR,
  MODIFIER_SHORT,
  MODIFIER_LONG,
  MODIFIER_LONG_LONG,
  MODIFIER_INTMAX,
  MODIFIER_SIZE,
  MODIFIER_PTRDIFF,
  MODIFIER_LONG_DOUBLE,
};

static bool is_space(char c) {
  return c == ' ' || c == '\t' || c == '\n' || c == '\v' || c == '\f' || c == '\r';
}

static int lower(int c) {
  return c >= 'A' && c <= 'Z' ? c + ('a' - 'A') : c;
}

static bool is_digit_in(char c, unsigned base) {
  unsigned value;
  if (c >= '0' && c <= '9') {
    value = (unsigned)(c - '0');
  } else if (lower(c) >= 'a' && lower(c) <= 'z') {
    value = (unsigned)(lower(c) - 'a' + 10);
  } else {
    return false;
  }
  return value < base;
}

static void store_integer(va_list* arguments, enum modifier modifier, uintmax_t value) {
  switch (modifier) {
    case MODIFIER_CHAR: *va_arg(*arguments, char*) = (char)value; break;
    case MODIFIER_SHORT: *va_arg(*arguments, short*) = (short)value; break;
    case MODIFIER_LONG: *va_arg(*arguments, long*) = (long)value; break;
    case MODIFIER_LONG_LONG: *va_arg(*arguments, long long*) = (long long)value; break;
    case MODIFIER_INTMAX: *va_arg(*arguments, intmax_t*) = (intmax_t)value; break;
    case MODIFIER_SIZE:
    case MODIFIER_PTRDIFF: *va_arg(*arguments, size_t*) = (size_t)value; break;
    default: *va_arg(*arguments, int*) = (int)value; break;
  }
}

// Widens exactly to the IEEE binary128 layout wasm32 uses for long double,
// without touching the soft-float routines.
static void store_long_double(long double* destination, double value) {
  union {
    double f;
    uint64_t bits;
  } in = {value};
  union {
    long double f;
    uint64_t words[2];
  } out;
  uint64_t sign = in.bits >> 63;
  uint64_t exponent = (in.bits >> 52) & 0x7ff;
  uint64_t mantissa = in.bits & (((uint64_t)1 << 52) - 1);
  uint64_t wide_exponent;
  if (exponent == 0x7ff) {
    wide_exponent = 0x7fff;
  } else if (exponent == 0 && mantissa == 0) {
    wide_exponent = 0;
  } else {
    if (exponent == 0) {
      while (!(mantissa & ((uint64_t)1 << 52))) {
        mantissa <<= 1;
        exponent--;
      }
      mantissa &= ((uint64_t)1 << 52) - 1;
      exponent++;
    }
    wide_exponent = exponent - 1023 + 16383;
  }
  out.words[1] = (sign << 63) | (wide_exponent << 48) | (mantissa >> 4);
  out.words[0] = mantissa << 60;
  *destination = out.f;
}

static void store_float(va_list* arguments, enum modifier modifier, double value) {
  switch (modifier) {
    case MODIFIER_LONG: *va_arg(*arguments, double*) = value; break;
    case MODIFIER_LONG_DOUBLE: store_long_double(va_arg(*arguments, long double*), value); break;
    default: *va_arg(*arguments, float*) = (float)value; break;
  }
}

typedef struct {
  bool set[256];
} scanset;

static const char* parse_scanset(const char* format, scanset* set) {
  bool negate = false;
  for (int i = 0; i < 256; i++) set->set[i] = false;
  if (*format == '^') {
    negate = true;
    format++;
  }
  if (*format == ']') {
    set->set[(unsigned char)']'] = true;
    format++;
  }
  while (*format && *format != ']') {
    unsigned char first = (unsigned char)*format++;
    if (*format == '-' && format[1] && format[1] != ']') {
      unsigned char last = (unsigned char)format[1];
      for (unsigned c = first; c <= last; c++) set->set[c] = true;
      format += 2;
    } else {
      set->set[first] = true;
    }
  }
  if (*format == ']') format++;
  if (negate) {
    for (int i = 0; i < 256; i++) set->set[i] = !set->set[i];
  }
  return format;
}

int console_libc_vsscanf(const char* input, const char* format, va_list arguments) {
  va_list remaining;
  va_copy(remaining, arguments);
  const char* p = input;
  int assigned = 0;
  bool input_failure = false;
  while (*format) {
    if (is_space(*format)) {
      while (is_space(*p)) p++;
      format++;
      continue;
    }
    if (*format != '%') {
      if (*p != *format) {
        if (!*p) input_failure = true;
        break;
      }
      p++;
      format++;
      continue;
    }
    format++;
    bool suppress = false;
    if (*format == '*') {
      suppress = true;
      format++;
    }
    int width = 0;
    while (*format >= '0' && *format <= '9') width = width * 10 + (*format++ - '0');
    enum modifier modifier = MODIFIER_NONE;
    switch (*format) {
      case 'h':
        format++;
        if (*format == 'h') {
          format++;
          modifier = MODIFIER_CHAR;
        } else {
          modifier = MODIFIER_SHORT;
        }
        break;
      case 'l':
        format++;
        if (*format == 'l') {
          format++;
          modifier = MODIFIER_LONG_LONG;
        } else {
          modifier = MODIFIER_LONG;
        }
        break;
      case 'j': format++; modifier = MODIFIER_INTMAX; break;
      case 'z': format++; modifier = MODIFIER_SIZE; break;
      case 't': format++; modifier = MODIFIER_PTRDIFF; break;
      case 'L': format++; modifier = MODIFIER_LONG_DOUBLE; break;
      default: break;
    }
    char conversion = *format;
    if (!conversion) break;
    format++;
    if (conversion == '%') {
      while (is_space(*p)) p++;
      if (*p != '%') {
        if (!*p) input_failure = true;
        break;
      }
      p++;
      continue;
    }
    if (conversion == 'n') {
      if (!suppress) store_integer(&remaining, modifier, (uintmax_t)(p - input));
      continue;
    }
    if (conversion != 'c' && conversion != '[') {
      while (is_space(*p)) p++;
    }
    if (!*p) {
      input_failure = true;
      break;
    }
    size_t limit = width > 0 && width < FIELD_LIMIT ? (size_t)width : FIELD_LIMIT - 1;
    char field[FIELD_LIMIT];
    size_t length = 0;
    switch (conversion) {
      case 'd':
      case 'i':
      case 'u':
      case 'o':
      case 'x':
      case 'X':
      case 'p': {
        unsigned base = conversion == 'i' ? 0 : conversion == 'o' ? 8 : conversion == 'u' || conversion == 'd' ? 10 : 16;
        const char* q = p;
        if ((*q == '+' || *q == '-') && length < limit) field[length++] = *q++;
        unsigned digit_base = base;
        if ((base == 0 || base == 16) && q[0] == '0' && (q[1] == 'x' || q[1] == 'X') &&
            is_digit_in(q[2], 16) && length + 2 < limit) {
          field[length++] = *q++;
          field[length++] = *q++;
          digit_base = 16;
        } else if (base == 0) {
          digit_base = *q == '0' ? 8 : 10;
        }
        size_t digits = 0;
        while (length < limit && is_digit_in(*q, digit_base)) {
          field[length++] = *q++;
          digits++;
        }
        if (digits == 0) goto finished;
        field[length] = '\0';
        char* end;
        uintmax_t value = conversion == 'd' || conversion == 'i'
                              ? (uintmax_t)console_libc_strtol(field, &end, (int)base)
                              : console_libc_strtoul(field, &end, (int)(base == 0 ? 0 : base));
        p = q;
        if (!suppress) {
          if (conversion == 'p') {
            *va_arg(remaining, void**) = (void*)(uintptr_t)value;
          } else {
            store_integer(&remaining, modifier, value);
          }
          assigned++;
        }
        break;
      }
      case 'a':
      case 'A':
      case 'e':
      case 'E':
      case 'f':
      case 'F':
      case 'g':
      case 'G': {
        const char* q = p;
        if ((*q == '+' || *q == '-') && length < limit) field[length++] = *q++;
        const char* word = NULL;
        if (lower(*q) == 'i') word = "infinity";
        if (lower(*q) == 'n') word = "nan";
        if (word) {
          size_t matched = 0;
          while (word[matched] && lower(q[matched]) == word[matched] && length + matched < limit) matched++;
          if (matched < 3) goto finished;
          if (matched < 8) matched = 3;
          for (size_t i = 0; i < matched; i++) field[length++] = q[i];
          q += matched;
        } else {
          unsigned base = 10;
          if (q[0] == '0' && lower(q[1]) == 'x' && length + 2 <= limit) {
            field[length++] = *q++;
            field[length++] = *q++;
            base = 16;
          }
          size_t digits = 0;
          bool seen_point = false;
          while (length < limit && (is_digit_in(*q, base) || (*q == '.' && !seen_point))) {
            if (*q == '.') seen_point = true;
            else digits++;
            field[length++] = *q++;
          }
          if (digits == 0) goto finished;
          char marker = base == 16 ? 'p' : 'e';
          if (lower(*q) == marker && length < limit) {
            const char* exponent = q + 1;
            size_t extra = 1;
            if (*exponent == '+' || *exponent == '-') {
              exponent++;
              extra++;
            }
            if (!is_digit_in(*exponent, 10) || length + extra >= limit) goto finished;
            while (extra-- > 0) field[length++] = *q++;
            while (length < limit && is_digit_in(*q, 10)) field[length++] = *q++;
          }
        }
        field[length] = '\0';
        char* end;
        double value = console_libc_strtod(field, &end);
        if (end == field) goto finished;
        p = q;
        if (!suppress) {
          store_float(&remaining, modifier, value);
          assigned++;
        }
        break;
      }
      case 's': {
        char* destination = suppress ? NULL : va_arg(remaining, char*);
        while (length < limit && *p && !is_space(*p)) {
          if (destination) destination[length] = *p;
          length++;
          p++;
        }
        if (destination) {
          destination[length] = '\0';
          assigned++;
        }
        break;
      }
      case 'c': {
        size_t count = width > 0 ? (size_t)width : 1;
        char* destination = suppress ? NULL : va_arg(remaining, char*);
        for (size_t i = 0; i < count; i++) {
          if (!p[i]) {
            input_failure = true;
            goto finished;
          }
        }
        if (destination) {
          for (size_t i = 0; i < count; i++) destination[i] = p[i];
          assigned++;
        }
        p += count;
        break;
      }
      case '[': {
        scanset set;
        format = parse_scanset(format, &set);
        char* destination = suppress ? NULL : va_arg(remaining, char*);
        while (length < limit && *p && set.set[(unsigned char)*p]) {
          if (destination) destination[length] = *p;
          length++;
          p++;
        }
        if (length == 0) goto finished;
        if (destination) {
          destination[length] = '\0';
          assigned++;
        }
        break;
      }
      default: goto finished;
    }
  }
finished:
  va_end(remaining);
  if (assigned == 0 && input_failure) return -1;
  return assigned;
}

int console_libc_sscanf(const char* input, const char* format, ...) {
  va_list arguments;
  va_start(arguments, format);
  int result = console_libc_vsscanf(input, format, arguments);
  va_end(arguments);
  return result;
}

#ifndef CONSOLE_LIBC_NATIVE_TEST
int vsscanf(const char* input, const char* format, va_list arguments) {
  return console_libc_vsscanf(input, format, arguments);
}

int sscanf(const char* input, const char* format, ...) {
  va_list arguments;
  va_start(arguments, format);
  int result = console_libc_vsscanf(input, format, arguments);
  va_end(arguments);
  return result;
}
#endif
