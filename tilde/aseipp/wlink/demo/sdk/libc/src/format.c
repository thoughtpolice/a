// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// printf-style formatting. Floating-point conversions are exact: the digits
// come from the binary value itself, rounded half to even at the requested
// place, so the output matches a hosted C library digit for digit.
#include <limits.h>
#include <stdarg.h>
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <string.h>

#include "bigint.h"
#include "internal.h"

// A double has fewer than this many significant decimal digits, so digits
// requested beyond it are zeros that need no computation.
#define EXACT_DIGITS 1100

typedef struct {
  char* buffer;
  size_t capacity;
  size_t length;
} sink;

static void put(sink* out, char character) {
  if (out->length < out->capacity) out->buffer[out->length] = character;
  out->length++;
}

static void put_text(sink* out, const char* text, size_t count) {
  for (size_t i = 0; i < count; i++) put(out, text[i]);
}

static void put_repeat(sink* out, char character, int count) {
  while (count-- > 0) put(out, character);
}

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

typedef struct {
  bool left;
  bool plus;
  bool space;
  bool alternate;
  bool zero;
  int width;
  int precision;
  enum modifier modifier;
  char conversion;
} spec;

// Every conversion is laid out as prefix, zero padding, body, trailing zeros,
// suffix, then padded to the field width on the side the flags select.
static void emit(sink* out, const spec* s, const char* prefix, size_t prefix_length,
                 const char* body, size_t body_length, int zeros, const char* suffix,
                 size_t suffix_length, bool zero_padding) {
  size_t content = prefix_length + body_length + (size_t)zeros + suffix_length;
  int padding = s->width > 0 && (size_t)s->width > content ? s->width - (int)content : 0;
  if (!s->left && !zero_padding) put_repeat(out, ' ', padding);
  put_text(out, prefix, prefix_length);
  if (!s->left && zero_padding) put_repeat(out, '0', padding);
  put_text(out, body, body_length);
  put_repeat(out, '0', zeros);
  put_text(out, suffix, suffix_length);
  if (s->left) put_repeat(out, ' ', padding);
}

static size_t sign_prefix(const spec* s, bool negative, char* prefix) {
  if (negative) {
    prefix[0] = '-';
  } else if (s->plus) {
    prefix[0] = '+';
  } else if (s->space) {
    prefix[0] = ' ';
  } else {
    return 0;
  }
  return 1;
}

static void format_integer(sink* out, const spec* s, uintmax_t magnitude, bool negative,
                           bool is_signed, unsigned base, bool uppercase) {
  const char* alphabet = uppercase ? "0123456789ABCDEF" : "0123456789abcdef";
  char reversed[64];
  int count = 0;
  uintmax_t value = magnitude;
  while (value) {
    reversed[count++] = alphabet[value % base];
    value /= base;
  }
  int zeros = 0;
  if (s->precision >= 0) {
    if (s->precision > count) zeros = s->precision - count;
  } else if (count == 0) {
    zeros = 1;
  }
  if (s->alternate && base == 8 && zeros == 0 && (count == 0 || reversed[count - 1] != '0')) zeros = 1;
  char prefix[3];
  size_t prefix_length = is_signed ? sign_prefix(s, negative, prefix) : 0;
  if (s->alternate && base == 16 && magnitude != 0) {
    prefix[prefix_length++] = '0';
    prefix[prefix_length++] = uppercase ? 'X' : 'x';
  }
  char body[128];
  size_t body_length = 0;
  while (zeros-- > 0) body[body_length++] = '0';
  while (count-- > 0) body[body_length++] = reversed[count];
  emit(out, s, prefix, prefix_length, body, body_length, 0, "", 0,
       s->zero && !s->left && s->precision < 0);
}

static intmax_t read_signed(va_list* arguments, enum modifier modifier) {
  switch (modifier) {
    case MODIFIER_CHAR: return (signed char)va_arg(*arguments, int);
    case MODIFIER_SHORT: return (short)va_arg(*arguments, int);
    case MODIFIER_LONG: return va_arg(*arguments, long);
    case MODIFIER_LONG_LONG: return va_arg(*arguments, long long);
    case MODIFIER_INTMAX: return va_arg(*arguments, intmax_t);
    case MODIFIER_SIZE:
    case MODIFIER_PTRDIFF: return va_arg(*arguments, ptrdiff_t);
    default: return va_arg(*arguments, int);
  }
}

static uintmax_t read_unsigned(va_list* arguments, enum modifier modifier) {
  switch (modifier) {
    case MODIFIER_CHAR: return (unsigned char)va_arg(*arguments, unsigned);
    case MODIFIER_SHORT: return (unsigned short)va_arg(*arguments, unsigned);
    case MODIFIER_LONG: return va_arg(*arguments, unsigned long);
    case MODIFIER_LONG_LONG: return va_arg(*arguments, unsigned long long);
    case MODIFIER_INTMAX: return va_arg(*arguments, uintmax_t);
    case MODIFIER_SIZE:
    case MODIFIER_PTRDIFF: return va_arg(*arguments, size_t);
    default: return va_arg(*arguments, unsigned);
  }
}

static uint64_t double_bits(double value) {
  union {
    double f;
    uint64_t bits;
  } u = {value};
  return u.bits;
}

static double double_from_bits(uint64_t bits) {
  union {
    uint64_t bits;
    double f;
  } u = {bits};
  return u.f;
}

// Narrows an IEEE binary128 value, which is what long double is on wasm32,
// without arithmetic on the wide type: the soft-float routines it would need
// are not part of the freestanding runtime.
static double from_long_double(long double value) {
  union {
    long double f;
    uint64_t words[2];
  } u = {value};
  uint64_t low = u.words[0];
  uint64_t high = u.words[1];
  uint64_t sign = high >> 63;
  int exponent = (int)((high >> 48) & 0x7fff);
  uint64_t fraction_high = high & (((uint64_t)1 << 48) - 1);
  if (exponent == 0x7fff) {
    if (fraction_high || low) return double_from_bits((sign << 63) | 0x7ff8000000000000ull);
    return double_from_bits((sign << 63) | 0x7ff0000000000000ull);
  }
  if (exponent == 0) return double_from_bits(sign << 63);
  unsigned __int128 significand = ((unsigned __int128)(fraction_high | ((uint64_t)1 << 48)) << 64) | low;
  int unbiased = exponent - 16383;
  int shift = 60;
  if (unbiased < -1022) {
    shift += -1022 - unbiased;
    unbiased = -1022;
  }
  if (shift > 113) return double_from_bits(sign << 63);
  uint64_t mantissa = (uint64_t)(significand >> shift);
  unsigned __int128 remainder = significand & ((((unsigned __int128)1) << shift) - 1);
  unsigned __int128 half = ((unsigned __int128)1) << (shift - 1);
  if (remainder > half || (remainder == half && (mantissa & 1))) mantissa++;
  uint64_t biased = (uint64_t)(unbiased + 1023);
  if (mantissa >= ((uint64_t)1 << 53)) {
    mantissa >>= 1;
    biased++;
  }
  if (mantissa < ((uint64_t)1 << 52)) biased = 0;
  if (biased >= 0x7ff) return double_from_bits((sign << 63) | 0x7ff0000000000000ull);
  return double_from_bits((sign << 63) | (biased << 52) | (mantissa & (((uint64_t)1 << 52) - 1)));
}

// The exact decimal expansion of a finite non-negative double: the integer
// digits up front and the fraction as a binary numerator that yields one
// decimal digit per step.
typedef struct {
  console_bigint numerator;
  int shift;
  char integer[330];
  int integer_count;
} expansion;

static void expansion_init(expansion* e, double x) {
  uint64_t bits = double_bits(x);
  int exponent = (int)((bits >> 52) & 0x7ff);
  uint64_t mantissa = bits & (((uint64_t)1 << 52) - 1);
  uint64_t m;
  int e2;
  if (exponent == 0) {
    m = mantissa;
    e2 = -1074;
  } else {
    m = mantissa | ((uint64_t)1 << 52);
    e2 = exponent - 1075;
  }
  console_bigint integer;
  if (e2 >= 0) {
    console_bigint_set(&integer, m);
    console_bigint_shift_left(&integer, e2);
    console_bigint_set(&e->numerator, 0);
    e->shift = 0;
  } else {
    e->shift = -e2;
    if (e->shift >= 64) {
      console_bigint_set(&integer, 0);
      console_bigint_set(&e->numerator, m);
    } else {
      console_bigint_set(&integer, m >> e->shift);
      console_bigint_set(&e->numerator, m & (((uint64_t)1 << e->shift) - 1));
    }
  }
  char reversed[330];
  int count = 0;
  while (!console_bigint_is_zero(&integer)) {
    uint32_t chunk = console_bigint_divide_small(&integer, 1000000000u);
    for (int i = 0; i < 9; i++) {
      reversed[count++] = (char)('0' + chunk % 10);
      chunk /= 10;
    }
  }
  while (count > 1 && reversed[count - 1] == '0') count--;
  if (count == 0) reversed[count++] = '0';
  for (int i = 0; i < count; i++) e->integer[i] = reversed[count - 1 - i];
  e->integer_count = count;
}

static int expansion_next_digit(expansion* e) {
  if (e->shift == 0 || console_bigint_is_zero(&e->numerator)) return 0;
  console_bigint_multiply_small(&e->numerator, 10);
  return (int)console_bigint_extract_high(&e->numerator, e->shift);
}

static bool expansion_has_more(const expansion* e) {
  return !console_bigint_is_zero(&e->numerator);
}

static bool rounds_up(int next, bool sticky, char last) {
  return next > 5 || (next == 5 && (sticky || ((last - '0') & 1)));
}

// Adds one at the last digit; true when every digit was a nine and the
// string is now all zeros, so the caller owes a leading one.
static bool increment_digits(char* digits, int count) {
  for (int i = count; i-- > 0;) {
    if (digits[i] == '9') {
      digits[i] = '0';
    } else {
      digits[i]++;
      return false;
    }
  }
  return true;
}

// The first `count` significant digits of a positive finite double, rounded
// half to even, and the decimal exponent of the leading digit.
static void significant_digits(double x, int count, char* digits, int* exponent10) {
  expansion e;
  expansion_init(&e, x);
  int produced = 0;
  int next;
  bool sticky;
  int exponent;
  if (e.integer_count > 1 || e.integer[0] != '0') {
    exponent = e.integer_count - 1;
    int i = 0;
    while (produced < count && i < e.integer_count) digits[produced++] = e.integer[i++];
    if (i < e.integer_count) {
      next = e.integer[i] - '0';
      sticky = expansion_has_more(&e);
      for (int j = i + 1; j < e.integer_count; j++) {
        if (e.integer[j] != '0') sticky = true;
      }
    } else {
      while (produced < count) digits[produced++] = (char)('0' + expansion_next_digit(&e));
      next = expansion_next_digit(&e);
      sticky = expansion_has_more(&e);
    }
  } else {
    int zeros = 0;
    int digit;
    while ((digit = expansion_next_digit(&e)) == 0) zeros++;
    exponent = -(zeros + 1);
    digits[produced++] = (char)('0' + digit);
    while (produced < count) digits[produced++] = (char)('0' + expansion_next_digit(&e));
    next = expansion_next_digit(&e);
    sticky = expansion_has_more(&e);
  }
  if (rounds_up(next, sticky, digits[count - 1]) && increment_digits(digits, count)) {
    digits[0] = '1';
    exponent++;
  }
  *exponent10 = exponent;
}

static size_t exponent_suffix(char* suffix, int exponent, bool uppercase) {
  size_t length = 0;
  suffix[length++] = uppercase ? 'E' : 'e';
  suffix[length++] = exponent < 0 ? '-' : '+';
  unsigned magnitude = exponent < 0 ? (unsigned)-exponent : (unsigned)exponent;
  char reversed[8];
  int count = 0;
  do {
    reversed[count++] = (char)('0' + magnitude % 10);
    magnitude /= 10;
  } while (magnitude);
  if (count < 2) reversed[count++] = '0';
  while (count-- > 0) suffix[length++] = reversed[count];
  return length;
}

static void format_fixed(sink* out, const spec* s, double x, bool negative) {
  int precision = s->precision < 0 ? 6 : s->precision;
  int computed = precision < EXACT_DIGITS ? precision : EXACT_DIGITS;
  expansion e;
  expansion_init(&e, x);
  char fraction[EXACT_DIGITS];
  for (int i = 0; i < computed; i++) fraction[i] = (char)('0' + expansion_next_digit(&e));
  int next = 0;
  bool sticky = false;
  if (computed == precision) {
    next = expansion_next_digit(&e);
    sticky = expansion_has_more(&e);
  }
  char last = precision > 0 ? fraction[computed - 1] : e.integer[e.integer_count - 1];
  if (rounds_up(next, sticky, last)) {
    bool carry = precision == 0 || increment_digits(fraction, computed);
    if (carry && increment_digits(e.integer, e.integer_count)) {
      e.integer[0] = '1';
      e.integer[e.integer_count++] = '0';
    }
  }
  char prefix[1];
  size_t prefix_length = sign_prefix(s, negative, prefix);
  char body[330 + 1 + EXACT_DIGITS];
  size_t body_length = 0;
  memcpy(body, e.integer, (size_t)e.integer_count);
  body_length += (size_t)e.integer_count;
  if (precision > 0 || s->alternate) body[body_length++] = '.';
  memcpy(body + body_length, fraction, (size_t)computed);
  body_length += (size_t)computed;
  emit(out, s, prefix, prefix_length, body, body_length, precision - computed, "", 0,
       s->zero && !s->left);
}

static void format_scientific(sink* out, const spec* s, double x, bool negative, bool uppercase) {
  int precision = s->precision < 0 ? 6 : s->precision;
  int computed = precision + 1 <= EXACT_DIGITS ? precision + 1 : EXACT_DIGITS;
  char digits[EXACT_DIGITS];
  int exponent = 0;
  if (x == 0) {
    memset(digits, '0', (size_t)computed);
  } else {
    significant_digits(x, computed, digits, &exponent);
  }
  char prefix[1];
  size_t prefix_length = sign_prefix(s, negative, prefix);
  char body[EXACT_DIGITS + 1];
  size_t body_length = 0;
  body[body_length++] = digits[0];
  if (precision > 0 || s->alternate) body[body_length++] = '.';
  memcpy(body + body_length, digits + 1, (size_t)(computed - 1));
  body_length += (size_t)(computed - 1);
  char suffix[12];
  size_t suffix_length = exponent_suffix(suffix, exponent, uppercase);
  emit(out, s, prefix, prefix_length, body, body_length, precision + 1 - computed, suffix,
       suffix_length, s->zero && !s->left);
}

static void format_general(sink* out, const spec* s, double x, bool negative, bool uppercase) {
  int precision = s->precision < 0 ? 6 : (s->precision == 0 ? 1 : s->precision);
  int computed = precision <= EXACT_DIGITS ? precision : EXACT_DIGITS;
  char digits[EXACT_DIGITS];
  int exponent = 0;
  if (x == 0) {
    memset(digits, '0', (size_t)computed);
  } else {
    significant_digits(x, computed, digits, &exponent);
  }
  char prefix[1];
  size_t prefix_length = sign_prefix(s, negative, prefix);
  char body[EXACT_DIGITS + 330];
  size_t body_length = 0;
  int zeros = s->alternate ? precision - computed : 0;
  char suffix[12];
  size_t suffix_length = 0;
  if (exponent < -4 || exponent >= precision) {
    int kept = computed - 1;
    if (!s->alternate) {
      while (kept > 0 && digits[kept] == '0') kept--;
    }
    body[body_length++] = digits[0];
    if (kept > 0 || s->alternate) body[body_length++] = '.';
    memcpy(body + body_length, digits + 1, (size_t)kept);
    body_length += (size_t)kept;
    suffix_length = exponent_suffix(suffix, exponent, uppercase);
  } else {
    int fraction_start;
    if (exponent >= 0) {
      memcpy(body, digits, (size_t)(exponent + 1));
      body_length = (size_t)(exponent + 1);
      fraction_start = exponent + 1;
    } else {
      body[body_length++] = '0';
      fraction_start = 0;
    }
    int fraction_count = computed - fraction_start;
    int leading_zeros = exponent < 0 ? -exponent - 1 : 0;
    if (!s->alternate) {
      while (fraction_count > 0 && digits[fraction_start + fraction_count - 1] == '0') fraction_count--;
      if (fraction_count == 0) leading_zeros = 0;
    }
    if (fraction_count > 0 || leading_zeros > 0 || s->alternate) {
      body[body_length++] = '.';
      memset(body + body_length, '0', (size_t)leading_zeros);
      body_length += (size_t)leading_zeros;
      memcpy(body + body_length, digits + fraction_start, (size_t)fraction_count);
      body_length += (size_t)fraction_count;
    }
  }
  emit(out, s, prefix, prefix_length, body, body_length, zeros, suffix, suffix_length,
       s->zero && !s->left);
}

static void format_double(sink* out, const spec* s, double value) {
  uint64_t bits = double_bits(value);
  bool negative = bits >> 63;
  bool uppercase = s->conversion == 'F' || s->conversion == 'E' || s->conversion == 'G';
  int exponent = (int)((bits >> 52) & 0x7ff);
  if (exponent == 0x7ff) {
    char prefix[1];
    size_t prefix_length = sign_prefix(s, negative, prefix);
    bool nan = (bits & (((uint64_t)1 << 52) - 1)) != 0;
    const char* body = nan ? (uppercase ? "NAN" : "nan") : (uppercase ? "INF" : "inf");
    emit(out, s, prefix, prefix_length, body, 3, 0, "", 0, false);
    return;
  }
  double magnitude = double_from_bits(bits & ~((uint64_t)1 << 63));
  switch (s->conversion) {
    case 'f':
    case 'F': format_fixed(out, s, magnitude, negative); break;
    case 'e':
    case 'E': format_scientific(out, s, magnitude, negative, uppercase); break;
    default: format_general(out, s, magnitude, negative, uppercase); break;
  }
}

static void format_string(sink* out, const spec* s, const char* text) {
  if (!text) text = "(null)";
  size_t length = 0;
  size_t limit = s->precision < 0 ? SIZE_MAX : (size_t)s->precision;
  while (length < limit && text[length]) length++;
  emit(out, s, "", 0, text, length, 0, "", 0, false);
}

static void store_count(va_list* arguments, enum modifier modifier, size_t length) {
  switch (modifier) {
    case MODIFIER_CHAR: *va_arg(*arguments, signed char*) = (signed char)length; break;
    case MODIFIER_SHORT: *va_arg(*arguments, short*) = (short)length; break;
    case MODIFIER_LONG: *va_arg(*arguments, long*) = (long)length; break;
    case MODIFIER_LONG_LONG: *va_arg(*arguments, long long*) = (long long)length; break;
    case MODIFIER_INTMAX: *va_arg(*arguments, intmax_t*) = (intmax_t)length; break;
    case MODIFIER_SIZE:
    case MODIFIER_PTRDIFF: *va_arg(*arguments, ptrdiff_t*) = (ptrdiff_t)length; break;
    default: *va_arg(*arguments, int*) = (int)length; break;
  }
}

static const char* parse_spec(const char* format, spec* s, va_list* arguments) {
  *s = (spec){.precision = -1};
  for (;; format++) {
    switch (*format) {
      case '-': s->left = true; continue;
      case '+': s->plus = true; continue;
      case ' ': s->space = true; continue;
      case '#': s->alternate = true; continue;
      case '0': s->zero = true; continue;
      default: break;
    }
    break;
  }
  if (*format == '*') {
    s->width = va_arg(*arguments, int);
    if (s->width < 0) {
      s->left = true;
      s->width = s->width == INT_MIN ? INT_MAX : -s->width;
    }
    format++;
  } else {
    while (*format >= '0' && *format <= '9') {
      s->width = s->width < INT_MAX / 10 ? s->width * 10 + (*format - '0') : INT_MAX;
      format++;
    }
  }
  if (*format == '.') {
    format++;
    s->precision = 0;
    if (*format == '*') {
      s->precision = va_arg(*arguments, int);
      if (s->precision < 0) s->precision = -1;
      format++;
    } else {
      while (*format >= '0' && *format <= '9') {
        s->precision = s->precision < INT_MAX / 10 ? s->precision * 10 + (*format - '0') : INT_MAX;
        format++;
      }
    }
  }
  switch (*format) {
    case 'h':
      format++;
      if (*format == 'h') {
        format++;
        s->modifier = MODIFIER_CHAR;
      } else {
        s->modifier = MODIFIER_SHORT;
      }
      break;
    case 'l':
      format++;
      if (*format == 'l') {
        format++;
        s->modifier = MODIFIER_LONG_LONG;
      } else {
        s->modifier = MODIFIER_LONG;
      }
      break;
    case 'j': format++; s->modifier = MODIFIER_INTMAX; break;
    case 'z': format++; s->modifier = MODIFIER_SIZE; break;
    case 't': format++; s->modifier = MODIFIER_PTRDIFF; break;
    case 'L': format++; s->modifier = MODIFIER_LONG_DOUBLE; break;
    default: break;
  }
  s->conversion = *format;
  return format;
}

int console_libc_vsnprintf(char* buffer, size_t size, const char* format, va_list arguments) {
  sink out = {buffer, size ? size - 1 : 0, 0};
  va_list remaining;
  va_copy(remaining, arguments);
  while (*format) {
    if (*format != '%') {
      put(&out, *format++);
      continue;
    }
    const char* start = format++;
    spec s;
    format = parse_spec(format, &s, &remaining);
    switch (s.conversion) {
      case 'd':
      case 'i': {
        intmax_t value = read_signed(&remaining, s.modifier);
        bool negative = value < 0;
        uintmax_t magnitude = negative ? (uintmax_t)0 - (uintmax_t)value : (uintmax_t)value;
        format_integer(&out, &s, magnitude, negative, true, 10, false);
        break;
      }
      case 'u': format_integer(&out, &s, read_unsigned(&remaining, s.modifier), false, false, 10, false); break;
      case 'o': format_integer(&out, &s, read_unsigned(&remaining, s.modifier), false, false, 8, false); break;
      case 'x': format_integer(&out, &s, read_unsigned(&remaining, s.modifier), false, false, 16, false); break;
      case 'X': format_integer(&out, &s, read_unsigned(&remaining, s.modifier), false, false, 16, true); break;
      case 'c': {
        char character = (char)va_arg(remaining, int);
        emit(&out, &s, "", 0, &character, 1, 0, "", 0, false);
        break;
      }
      case 's': format_string(&out, &s, va_arg(remaining, const char*)); break;
      case 'p': {
        void* pointer = va_arg(remaining, void*);
        if (!pointer) {
          emit(&out, &s, "", 0, "(nil)", 5, 0, "", 0, false);
        } else {
          s.alternate = true;
          format_integer(&out, &s, (uintptr_t)pointer, false, false, 16, false);
        }
        break;
      }
      case 'n': store_count(&remaining, s.modifier, out.length); break;
      case 'f':
      case 'F':
      case 'e':
      case 'E':
      case 'g':
      case 'G': {
        double value = s.modifier == MODIFIER_LONG_DOUBLE ? from_long_double(va_arg(remaining, long double))
                                                          : va_arg(remaining, double);
        format_double(&out, &s, value);
        break;
      }
      case '%': put(&out, '%'); break;
      case '\0': put_text(&out, start, (size_t)(format - start)); continue;
      default: put_text(&out, start, (size_t)(format - start) + 1); break;
    }
    format++;
  }
  va_end(remaining);
  if (size) buffer[out.length < out.capacity ? out.length : out.capacity] = '\0';
  return out.length > INT_MAX ? -1 : (int)out.length;
}

int console_libc_snprintf(char* buffer, size_t size, const char* format, ...) {
  va_list arguments;
  va_start(arguments, format);
  int result = console_libc_vsnprintf(buffer, size, format, arguments);
  va_end(arguments);
  return result;
}

#ifndef CONSOLE_LIBC_NATIVE_TEST
int vsnprintf(char* buffer, size_t size, const char* format, va_list arguments) {
  return console_libc_vsnprintf(buffer, size, format, arguments);
}

int snprintf(char* buffer, size_t size, const char* format, ...) {
  va_list arguments;
  va_start(arguments, format);
  int result = console_libc_vsnprintf(buffer, size, format, arguments);
  va_end(arguments);
  return result;
}

int vsprintf(char* buffer, const char* format, va_list arguments) {
  return console_libc_vsnprintf(buffer, SIZE_MAX, format, arguments);
}

int sprintf(char* buffer, const char* format, ...) {
  va_list arguments;
  va_start(arguments, format);
  int result = console_libc_vsnprintf(buffer, SIZE_MAX, format, arguments);
  va_end(arguments);
  return result;
}
#endif
