// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// The portable formatting and parsing routines against the host's C library:
// the same inputs must give the same text, values, end pointers, and counts.
#include <errno.h>
#include <float.h>
#include <limits.h>
#include <math.h>
#include <stdarg.h>
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "../src/internal.h"

// Where the standard leaves printf and strtol open, the SDK does what glibc
// does, so that engines written against a hosted C library see the same text.
// Other hosts choose differently and are no oracle there: Darwin's libc prints
// a null %p as 0x0 rather than (nil), honours a width on %% and the 0 flag on
// %s and %c, drops the sign of a NaN, discards an unknown conversion instead
// of printing it, sets errno to EINVAL when strtol converts nothing, and lets
// sscanf's %f take "1e" as 1 followed by an e.
#if defined(__GLIBC__)
#define HOST_IS_GLIBC 1
#else
#define HOST_IS_GLIBC 0
#endif

static int failures;
static int checks;

static uint64_t state = 0x9e3779b97f4a7c15ull;

static uint64_t next_random(void) {
  state ^= state << 13;
  state ^= state >> 7;
  state ^= state << 17;
  return state;
}

static void report(const char* what, const char* detail) {
  failures++;
  if (failures <= 40) fprintf(stderr, "FAIL %s: %s\n", what, detail);
}

// glibc drops the trailing zeros of %#g when rounding carries into a new
// digit ("1.e+06" for 999999.5); the standard keeps them.
static bool known_host_bug(const char* format, const char* expected) {
  if (!strchr(format, '#') || !(strchr(format, 'g') || strchr(format, 'G'))) return false;
  return strstr(expected, ".e") != NULL || strstr(expected, ".E") != NULL;
}

static void check_format(int line, const char* format, ...) {
  char expected[4096];
  char actual[4096];
  va_list a;
  va_list b;
  va_start(a, format);
  va_copy(b, a);
  int expected_length = vsnprintf(expected, sizeof expected, format, a);
  int actual_length = console_libc_vsnprintf(actual, sizeof actual, format, b);
  va_end(a);
  va_end(b);
  checks++;
  if (known_host_bug(format, expected)) return;
  if (!HOST_IS_GLIBC && (strstr(actual, "nan") || strstr(actual, "NAN"))) return;
  if (expected_length != actual_length || strcmp(expected, actual) != 0) {
    char detail[9000];
    snprintf(detail, sizeof detail, "line %d format \"%s\": expected [%s] (%d), got [%s] (%d)", line,
             format, expected, expected_length, actual, actual_length);
    report("printf", detail);
  }
}

#define FORMAT(...) check_format(__LINE__, __VA_ARGS__)

static void check_truncation(const char* format, size_t size, double value) {
  char expected[64];
  char actual[64];
  memset(expected, 'x', sizeof expected);
  memset(actual, 'x', sizeof actual);
  int expected_length = snprintf(expected, size, format, value);
  int actual_length = console_libc_snprintf(actual, size, format, value);
  checks++;
  if (expected_length != actual_length || memcmp(expected, actual, sizeof expected) != 0) {
    char detail[256];
    snprintf(detail, sizeof detail, "format \"%s\" size %zu: expected %d, got %d", format, size,
             expected_length, actual_length);
    report("truncation", detail);
  }
}

static double random_double(void) {
  union {
    uint64_t bits;
    double f;
  } u = {next_random()};
  return u.f;
}

static void test_printf(void) {
  FORMAT("%d|%i|%u|%x|%X|%o|%c|%s|%%", 42, -42, 42u, 255u, 255u, 8u, 'z', "str");
  FORMAT("%5d|%-5d|%05d|%+d|% d|%+5d|%-+5d|%.3d|%5.3d|%-5.3d|%05.3d", 42, 42, 42, 42, 42, 42, 42, 42,
         42, 42, 42);
  FORMAT("%d|%d|%d|%u|%u", INT_MIN, INT_MAX, 0, UINT_MAX, 0u);
  FORMAT("%ld|%lld|%lu|%llu|%zu|%zd|%jd|%td", LONG_MIN, LLONG_MIN, ULONG_MAX, ULLONG_MAX,
         (size_t)123, (ptrdiff_t)-5, (intmax_t)-7, (ptrdiff_t)-9);
  FORMAT("%hhd|%hd|%hhu|%hu|%hhx", 300, 70000, 300, 70000, 300);
  FORMAT("%.0d|%.0x|%#x|%#X|%#o|%#.0o|%#5x|%#-8x|%#08x|%x|%#o", 0, 0, 0u, 255u, 8u, 0u, 255u, 255u,
         255u, 0xdeadbeefu, 0u);
  FORMAT("%s|%.2s|%10s|%-10s|%.0s|%10.3s|%-10.2s|%s", "hello", "hello", "hi", "hi", "hi", "hello",
         "hello", "");
  FORMAT("%c|%3c|%-3c", 'a', 'b', 'c');
  FORMAT("%p|%12p|%-12p|", (void*)0x1234, (void*)0xabcdef, (void*)0x10);
  if (HOST_IS_GLIBC) {
    // Left open by the standard: the 0 flag on %s and %c, a null %p, a width
    // on %%, and conversions that do not exist.
    FORMAT("%05s|%05c", "ab", 'x');
    FORMAT("%p", (void*)0);
    FORMAT("%5%|%-5%|", 1);
    FORMAT("%ll%|%y|%", 1);
  }
  FORMAT("%*d|%-*d|%.*d|%*.*d|%*d", 6, 42, 6, 42, 4, 42, 8, 3, 42, -6, 42);
  FORMAT("%s|%.3s", (char*)NULL, "abcdef");
  FORMAT("plain text without conversions");
  FORMAT("%-+08.3f|%+08.3f|% 08.3f|%-#12.5g|", 3.14159, -3.14159, 3.14159, 100.0);
  int expected_count = -1;
  int actual_count = -1;
  char expected[64];
  char actual[64];
  snprintf(expected, sizeof expected, "abc%n%d%n", &expected_count, 42, &expected_count);
  console_libc_snprintf(actual, sizeof actual, "abc%n%d%n", &actual_count, 42, &actual_count);
  checks++;
  if (expected_count != actual_count || strcmp(expected, actual) != 0) report("printf", "%n");
  size_t sizes[] = {0, 1, 2, 5, 7, 8, 9, 20};
  for (size_t i = 0; i < sizeof sizes / sizeof sizes[0]; i++) {
    check_truncation("%.4f", sizes[i], 3.14159);
    check_truncation("%-10.2e|", sizes[i], -2.5);
  }

  static const double values[] = {
      0.0, -0.0, 1.0, -1.0, 0.5, 1.5, 2.5, 0.125, 0.1, 0.2, 0.3, 1.0 / 3, 2.0 / 3,
      3.14159265358979323846, 2.71828182845904523536, 1e-5, 1e-7, 123456.789, 999999.5,
      999999.4999, 0.0000123456, 1e15, 1e16, 1e17, 1e21, 1e22, 1e23, 1e100, 1e300,
      1.7976931348623157e308, 2.2250738585072014e-308, 2.2250738585072009e-308, 5e-324,
      4.9406564584124654e-324, 9007199254740992.0, 9007199254740993.0, 0.9999999, 9.9999999,
      99.99999999, 1234567.0, 0.05, 0.25, 0.75, 1e-320, 123.456e-300, 3.0e-10, 5e-5, 0.00001,
      1e-4, 12345678901234567890.0, 0.000095, 0.5e-6, 1.5e-6, 2.5e-6, 1e6, 1e7, 123456789.0,
      0.30000000000000004, 1.0000000000000002, 4503599627370496.5, INFINITY, -INFINITY, NAN, -NAN,
  };
  static const char* const formats[] = {
      "%f", "%.0f", "%.1f", "%.2f", "%.3f", "%.10f", "%.17f", "%.20f", "%.30f", "%e", "%.0e",
      "%.1e", "%.3e", "%.10e", "%.17e", "%E", "%g", "%.0g", "%.1g", "%.3g", "%.5g", "%.10g",
      "%.15g", "%.16g", "%.17g", "%.20g", "%G", "%10.3f", "%-12.4e|", "%+f", "% f", "%08.2f",
      "%-08.2f|", "%#.0f", "%#g", "%#.3g", "%#.0e", "%010.2e", "%12g|", "%-12g|", "%012g", "%+.3g",
      "%.60g", "%.100f", "%25.15e", "%F", "%#12.4F|", "%030.10e", "%.400f", "%.0F",
  };
  for (size_t v = 0; v < sizeof values / sizeof values[0]; v++) {
    for (size_t f = 0; f < sizeof formats / sizeof formats[0]; f++) {
      FORMAT(formats[f], values[v]);
    }
  }
  for (int i = 0; i < 20000; i++) {
    double value = random_double();
    FORMAT("%.17g", value);
    FORMAT("%g", value);
    FORMAT("%e", value);
    FORMAT("%.3f", value);
    FORMAT("%.12e", value);
    FORMAT("%.1g", value);
    FORMAT("%.25g", value);
    FORMAT("%#.8g", value);
    double nice = (double)(int64_t)(next_random() % 2000001) / 1000.0 - 1000.0;
    FORMAT("%f", nice);
    FORMAT("%.2f", nice);
    FORMAT("%g", nice);
  }
#if LDBL_MANT_DIG == 113
  FORMAT("%Lf|%Le|%Lg|%.3Lf", (long double)3.25, (long double)1e100, (long double)-0.001,
         (long double)2.0 / 3.0);
  FORMAT("%Lf|%Lg", (long double)5e-324, (long double)1.7976931348623157e308);
#endif
}

static bool same_double(double left, double right) {
  if (isnan(left) || isnan(right)) return isnan(left) && isnan(right);
  return memcmp(&left, &right, sizeof left) == 0;
}

static void check_strtod(const char* text) {
  char* expected_end;
  char* actual_end;
  double expected = strtod(text, &expected_end);
  double actual = console_libc_strtod(text, &actual_end);
  checks++;
  if (!same_double(expected, actual) || expected_end != actual_end) {
    char detail[1200];
    snprintf(detail, sizeof detail, "\"%.200s\": expected %.17g (end +%td), got %.17g (end +%td)",
             text, expected, expected_end - text, actual, actual_end - text);
    report("strtod", detail);
  }
}

static void test_strtod(void) {
  static const char* const table[] = {
      "0", "1", "-1.5", "1e10", "1E-10", "  3.14abc", "1e400", "-1e400", "1e-400", "0x1.8p1",
      "0x10", "0x.8", "0x1p-1074", "0x1p-1075", "0x1.fffffffffffff8p1023", "0x1p1024", "0xg",
      "inf", "-Infinity", "INF", "nan", "NaN", "nan(123)", "nan(abc_1)", "nan(", ".5", "5.",
      "1e", "1e+", "-", "", "+.e5", ".", "e5", "123456789012345678901234567890",
      "9007199254740993", "9007199254740992.5", "9007199254740993.0000000000000001",
      "2.2250738585072011e-308", "2.2250738585072012e-308", "2.2250738585072014e-308",
      "1.7976931348623158e308", "1.7976931348623159e308", "4.9406564584124654e-324",
      "2.4703282292062327e-324", "2.4703282292062328e-324", "1e-324", "3e-324",
      "0.000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000001e100",
      "1000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000e-100",
      "0.1", "0.2", "0.3", "1.1", "2.675", "1e23", "8.5e23", "1e22", "1e21", "123.456e-2",
      "   -0", "-0.0e0", "+0x0p0", "1_000", "1,5", "1.5.5", "1e5e5", "0000000000000000000012.5",
      "1234567890123456789012345678901234567890e-30", "179769313486231570000000000000000000"
      "00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000"
      "00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000"
      "00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000",
      "7.4109846876186981626485318930233205854758970392148714663837852375101326090531312779794975454245398"
      "8567125248543629467541945071565831097022848594166069612385776032093069045018313931069366011788824"
      "8712932034195254331089286735656625932848024889101591148118616367893116329871617926723936253963612"
      "6013573629456464013584789112432344826236088371398133136464012734209848101868047633623098562532321"
      "88096793431806342659534564359236423424345224203456781260003435894012235532415414143515464651e-324",
  };
  for (size_t i = 0; i < sizeof table / sizeof table[0]; i++) check_strtod(table[i]);
  errno = 0;
  console_libc_strtod("1e400", NULL);
  checks++;
  if (errno != ERANGE) report("strtod", "1e400 errno");
  errno = 0;
  console_libc_strtod("1e-400", NULL);
  checks++;
  if (errno != ERANGE) report("strtod", "1e-400 errno");
  char text[400];
  for (int i = 0; i < 20000; i++) {
    double value = random_double();
    if (isnan(value) || isinf(value)) continue;
    snprintf(text, sizeof text, "%.17g", value);
    check_strtod(text);
    snprintf(text, sizeof text, "%.16g", value);
    check_strtod(text);
    snprintf(text, sizeof text, "%.15e", value);
    check_strtod(text);
    snprintf(text, sizeof text, "%.25e", value);
    check_strtod(text);
    if (fabs(value) < 1e30) {
      snprintf(text, sizeof text, "%f", value);
      check_strtod(text);
    }
    int digits = 1 + (int)(next_random() % 45);
    int point = (int)(next_random() % (uint64_t)(digits + 1));
    size_t length = 0;
    if (next_random() & 1) text[length++] = '-';
    for (int d = 0; d < digits; d++) {
      if (d == point) text[length++] = '.';
      text[length++] = (char)('0' + next_random() % 10);
    }
    int exponent = (int)(next_random() % 700) - 350;
    snprintf(text + length, sizeof text - length, "e%d", exponent);
    check_strtod(text);
  }
}

static void check_strtol(const char* text, int base) {
  char* expected_end;
  char* actual_end;
  errno = 0;
  long expected = strtol(text, &expected_end, base);
  int expected_errno = errno;
  errno = 0;
  long actual = console_libc_strtol(text, &actual_end, base);
  int actual_errno = errno;
  bool valid_base = base == 0 || (base >= 2 && base <= 36);
  if (!valid_base) expected_end = actual_end;
  // BSD libcs report a string with nothing to convert as EINVAL; glibc and
  // the SDK leave errno alone, as the standard allows.
  if (!HOST_IS_GLIBC && valid_base && expected_end == text && expected_errno == EINVAL) expected_errno = 0;
  checks++;
  if (expected != actual || expected_end != actual_end || expected_errno != actual_errno) {
    char detail[300];
    snprintf(detail, sizeof detail, "strtol(\"%s\", %d): expected %ld end +%td errno %d, got %ld end +%td errno %d",
             text, base, expected, expected_end - text, expected_errno, actual, actual_end - text,
             actual_errno);
    report("strtol", detail);
  }
  errno = 0;
  unsigned long expected_unsigned = strtoul(text, &expected_end, base);
  expected_errno = errno;
  errno = 0;
  unsigned long actual_unsigned = console_libc_strtoul(text, &actual_end, base);
  actual_errno = errno;
  if (!valid_base) expected_end = actual_end;
  if (!HOST_IS_GLIBC && valid_base && expected_end == text && expected_errno == EINVAL) expected_errno = 0;
  checks++;
  if (expected_unsigned != actual_unsigned || expected_end != actual_end ||
      expected_errno != actual_errno) {
    char detail[300];
    snprintf(detail, sizeof detail, "strtoul(\"%s\", %d): expected %lu end +%td errno %d, got %lu end +%td errno %d",
             text, base, expected_unsigned, expected_end - text, expected_errno, actual_unsigned,
             actual_end - text, actual_errno);
    report("strtoul", detail);
  }
}

static void test_strtol(void) {
  static const char* const table[] = {
      "0", "  42", "-42", "+42", "0x1f", "0X1F", "0x", "0xg", "017", "08", "abc", "", "-", "+",
      "  -0x10", "2147483647", "2147483648", "-2147483648", "-2147483649", "9223372036854775807",
      "9223372036854775808", "-9223372036854775808", "-9223372036854775809",
      "18446744073709551615", "18446744073709551616", "-18446744073709551615",
      "-18446744073709551616", "zz", "1010", "777", "  \t\n 99x", "-0", "+-1", "0x-1", " 0x 1",
      "99999999999999999999999999999", "-99999999999999999999999999999", "Zz", "1e5", "0b101",
  };
  static const int bases[] = {0, 2, 8, 10, 16, 36};
  for (size_t i = 0; i < sizeof table / sizeof table[0]; i++) {
    for (size_t b = 0; b < sizeof bases / sizeof bases[0]; b++) check_strtol(table[i], bases[b]);
  }
  check_strtol("42", 1);
  check_strtol("42", 37);
  check_strtol("42", -1);
  char text[64];
  for (int i = 0; i < 20000; i++) {
    int base = (int)(next_random() % 37);
    if (base == 1) base = 0;
    size_t length = 0;
    if (next_random() % 3 == 0) text[length++] = ' ';
    if (next_random() & 1) text[length++] = (next_random() & 1) ? '-' : '+';
    if (next_random() % 4 == 0) {
      text[length++] = '0';
      text[length++] = 'x';
    }
    int digits = (int)(next_random() % 24);
    for (int d = 0; d < digits; d++) {
      unsigned value = (unsigned)(next_random() % 36);
      text[length++] = (char)(value < 10 ? '0' + value : 'a' + value - 10);
    }
    text[length] = '\0';
    check_strtol(text, base);
  }
}

#define SCAN(input, format, ...)                                                                \
  do {                                                                                          \
    int expected_result = sscanf(input, format, __VA_ARGS__);                                   \
    unsigned char expected_bytes[sizeof storage];                                               \
    memcpy(expected_bytes, &storage, sizeof storage);                                            \
    memset(&storage, 0, sizeof storage);                                                         \
    int actual_result = console_libc_sscanf(input, format, __VA_ARGS__);                        \
    checks++;                                                                                   \
    if (expected_result != actual_result ||                                                     \
        memcmp(expected_bytes, &storage, sizeof storage) != 0) {                                 \
      char detail[300];                                                                         \
      snprintf(detail, sizeof detail, "sscanf(\"%s\", \"%s\"): expected %d, got %d", input,     \
               format, expected_result, actual_result);                                         \
      report("sscanf", detail);                                                                 \
    }                                                                                           \
    memset(&storage, 0, sizeof storage);                                                         \
  } while (0)

static void test_sscanf(void) {
  union {
    int integers[8];
    unsigned unsigneds[8];
    float floats[8];
    double doubles[8];
    char characters[64];
    short shorts[8];
    long longs[8];
    long long long_longs[8];
    signed char bytes[8];
    void* pointers[8];
    long double long_doubles[2];
  } storage;
  memset(&storage, 0, sizeof storage);
  SCAN("12 34", "%d %d", &storage.integers[0], &storage.integers[1]);
  SCAN("  -5\t+6", "%d %d", &storage.integers[0], &storage.integers[1]);
  SCAN("12", "%d %d", &storage.integers[0], &storage.integers[1]);
  SCAN("", "%d %d", &storage.integers[0], &storage.integers[1]);
  SCAN("   ", "%d", &storage.integers[0]);
  SCAN("x", "%d %d", &storage.integers[0], &storage.integers[1]);
  SCAN("12 x", "%d %d", &storage.integers[0], &storage.integers[1]);
  SCAN("0x1f 017 42", "%i %i %i", &storage.integers[0], &storage.integers[1], &storage.integers[2]);
  SCAN("42 ff 17", "%u %x %o", &storage.unsigneds[0], &storage.unsigneds[1], &storage.unsigneds[2]);
  SCAN("0x1A", "%x", &storage.unsigneds[0]);
  SCAN("-0x10", "%i", &storage.integers[0]);
  SCAN("1.5 2.25 -3e2", "%f %f %f", &storage.floats[0], &storage.floats[1], &storage.floats[2]);
  SCAN("0.1 1e-3", "%lf %lf", &storage.doubles[0], &storage.doubles[1]);
  SCAN("inf", "%f", &storage.floats[0]);
  SCAN("nan", "%f", &storage.floats[0]);
  SCAN("-.5", "%f", &storage.floats[0]);
  if (HOST_IS_GLIBC) {
    // Matching failures under the standard's longest-prefix rule, which
    // glibc and the SDK apply; BSD scanners back up and accept the 1.
    SCAN("1e", "%f", &storage.floats[0]);
    SCAN("1e+", "%f", &storage.floats[0]);
  }
  SCAN("1.5e2abc", "%f%s", &storage.floats[0], storage.characters + 32);
  SCAN("0x1p3 infinity inf nanx", "%f %f %f %f", &storage.floats[0], &storage.floats[1], &storage.floats[2], &storage.floats[3]);
  SCAN("-inx", "%f", &storage.floats[0]);
  SCAN("1.5e2", "%3f", &storage.floats[0]);
  SCAN("+", "%f", &storage.floats[0]);
  SCAN("abc", "%f", &storage.floats[0]);
  SCAN("3.5e+2x", "%lfx", &storage.doubles[0]);
  SCAN("hello world", "%s", storage.characters);
  SCAN("abcdefgh", "%5s", storage.characters);
  SCAN("a b", "%s %s", storage.characters, storage.characters + 32);
  SCAN("", "%s", storage.characters);
  SCAN("xyz", "%c", storage.characters);
  SCAN("xyz", "%3c", storage.characters);
  SCAN("", "%c", storage.characters);
  SCAN("abcabcd", "%[a-c]", storage.characters);
  SCAN("hello,world", "%[^,]", storage.characters);
  SCAN("]x]y", "%[]x]", storage.characters);
  SCAN("123456", "%5[0-9]", storage.characters);
  SCAN("xyz", "%[0-9]", storage.characters);
  SCAN("1 2", "%*d %d", &storage.integers[0]);
  SCAN("123abc", "%d%n", &storage.integers[0], &storage.integers[1]);
  SCAN("300 70000 -5 9000000000", "%hhd %hd %ld %lld", &storage.bytes[0], &storage.shorts[1],
       &storage.longs[1], &storage.long_longs[2]);
  SCAN("1,2", "%d,%d", &storage.integers[0], &storage.integers[1]);
  SCAN("1 ,2", "%d,%d", &storage.integers[0], &storage.integers[1]);
  SCAN("12345", "%2d%2d", &storage.integers[0], &storage.integers[1]);
  SCAN("0x1234", "%p", &storage.pointers[0]);
  SCAN("%5", "%%%d", &storage.integers[0]);
  SCAN("5;", "%d:", &storage.integers[0]);
  SCAN("  42  ", "%d %d", &storage.integers[0], &storage.integers[1]);
  SCAN("1.5 2.5 -3", "%f %f %f", &storage.floats[0], &storage.floats[1], &storage.floats[2]);
  SCAN("a", "%c%c", storage.characters, storage.characters + 1);
  SCAN("12ab", "%d%s", &storage.integers[0], storage.characters);
#if LDBL_MANT_DIG == 113
  SCAN("2.5 -0.125", "%Lf %Lf", &storage.long_doubles[0], &storage.long_doubles[1]);
#endif
}

static int compare_ints(const void* left, const void* right) {
  int a = *(const int*)left;
  int b = *(const int*)right;
  return a < b ? -1 : a > b;
}

typedef struct {
  int key;
  int payload;
} record;

static int compare_records(const void* left, const void* right) {
  return compare_ints(&((const record*)left)->key, &((const record*)right)->key);
}

static void test_qsort(void) {
  int expected[256];
  int actual[256];
  record expected_records[128];
  record actual_records[128];
  for (int round = 0; round < 500; round++) {
    size_t count = next_random() % 257;
    for (size_t i = 0; i < count; i++) expected[i] = actual[i] = (int)(next_random() % 50) - 25;
    qsort(expected, count, sizeof expected[0], compare_ints);
    console_libc_qsort(actual, count, sizeof actual[0], compare_ints);
    checks++;
    if (memcmp(expected, actual, count * sizeof expected[0]) != 0) report("qsort", "int order");
    for (size_t i = 0; i < count && i < 8; i++) {
      int key = actual[next_random() % (count ? count : 1)];
      int* found = console_libc_bsearch(&key, actual, count, sizeof actual[0], compare_ints);
      checks++;
      if (!found || *found != key) report("bsearch", "present key");
      int missing = 100;
      checks++;
      if (console_libc_bsearch(&missing, actual, count, sizeof actual[0], compare_ints)) {
        report("bsearch", "missing key");
      }
    }
    size_t record_count = next_random() % 129;
    for (size_t i = 0; i < record_count; i++) {
      expected_records[i].key = actual_records[i].key = (int)(next_random() % 20);
      expected_records[i].payload = actual_records[i].payload = (int)i;
    }
    qsort(expected_records, record_count, sizeof expected_records[0], compare_records);
    console_libc_qsort(actual_records, record_count, sizeof actual_records[0], compare_records);
    for (size_t i = 0; i < record_count; i++) {
      checks++;
      if (expected_records[i].key != actual_records[i].key) report("qsort", "record order");
    }
  }
}

int main(void) {
  test_printf();
  test_strtod();
  test_strtol();
  test_sscanf();
  test_qsort();
  printf("%d checks, %d failures\n", checks, failures);
  return failures ? 1 : 0;
}
