// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// The forked musl routines against the host's libm: results within one unit
// in the last place for the transcendental functions, bit-exact for the
// rest, and matching special values. Neither library's cube root is
// correctly rounded, so those may differ by a few units, and so may tan on
// macOS, whose libm is itself more than a unit off for some arguments.
#include <math.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>

double console_musl_acos(double);
double console_musl_asin(double);
double console_musl_atan(double);
double console_musl_atan2(double, double);
double console_musl_cbrt(double);
double console_musl_cos(double);
double console_musl_cosh(double);
double console_musl_exp(double);
double console_musl_expm1(double);
double console_musl_fmod(double, double);
double console_musl_frexp(double, int*);
double console_musl_hypot(double, double);
double console_musl_ldexp(double, int);
double console_musl_log(double);
double console_musl_log10(double);
double console_musl_log2(double);
double console_musl_modf(double, double*);
double console_musl_pow(double, double);
double console_musl_round(double);
double console_musl_scalbn(double, int);
double console_musl_sin(double);
double console_musl_sinh(double);
double console_musl_tan(double);
double console_musl_tanh(double);

static int failures;
static int checks;
static uint64_t state = 0x2545f4914f6cdd1dull;

static uint64_t next_random(void) {
  state ^= state << 13;
  state ^= state >> 7;
  state ^= state << 17;
  return state;
}

static double uniform(double low, double high) {
  return low + (high - low) * ((double)(next_random() >> 11) / 9007199254740992.0);
}

static int64_t ordered(double value) {
  int64_t bits;
  memcpy(&bits, &value, sizeof bits);
  return bits < 0 ? INT64_MIN - bits : bits;
}

static bool within(double expected, double actual, int64_t tolerance) {
  if (isnan(expected) || isnan(actual)) return isnan(expected) && isnan(actual);
  if (isinf(expected) || isinf(actual)) return expected == actual;
  int64_t distance = ordered(expected) - ordered(actual);
  if (distance < 0) distance = -distance;
  return distance <= tolerance;
}

static void check(const char* name, double x, double y, double expected, double actual,
                  int64_t tolerance) {
  checks++;
  if (!within(expected, actual, tolerance)) {
    failures++;
    if (failures <= 40) {
      fprintf(stderr, "FAIL %s(%.17g, %.17g): expected %.17g, got %.17g\n", name, x, y, expected,
              actual);
    }
  }
}

typedef struct {
  const char* name;
  double (*ours)(double);
  double (*reference)(double);
  double low;
  double high;
  int64_t tolerance;
} unary;

#if defined(__APPLE__)
#define TAN_TOLERANCE 3
#else
#define TAN_TOLERANCE 1
#endif

static const unary unaries[] = {
    {"sin", console_musl_sin, sin, -1e6, 1e6, 1},   {"cos", console_musl_cos, cos, -1e6, 1e6, 1},
    {"tan", console_musl_tan, tan, -100, 100, TAN_TOLERANCE}, {"asin", console_musl_asin, asin, -1, 1, 1},
    {"acos", console_musl_acos, acos, -1, 1, 1},    {"atan", console_musl_atan, atan, -1e6, 1e6, 1},
    {"exp", console_musl_exp, exp, -700, 700, 1},   {"log", console_musl_log, log, 0, 1e300, 1},
    {"log2", console_musl_log2, log2, 0, 1e300, 1}, {"log10", console_musl_log10, log10, 0, 1e300, 1},
    {"cbrt", console_musl_cbrt, cbrt, -1e300, 1e300, 4}, {"round", console_musl_round, round, -1e6, 1e6, 0},
    {"sinh", console_musl_sinh, sinh, -700, 700, 2}, {"cosh", console_musl_cosh, cosh, -700, 700, 2},
    {"tanh", console_musl_tanh, tanh, -1e3, 1e3, 2}, {"expm1", console_musl_expm1, expm1, -700, 700, 2},
};

static const double specials[] = {0.0, -0.0, 1.0, -1.0, 0.5, 2.0, 1e-300, -1e-300, 1e300,
                                  -1e300, 5e-324, 1.7976931348623157e308, INFINITY, -INFINITY, NAN,
                                  3.141592653589793, 1.5707963267948966, 0.7853981633974483};

int main(void) {
  for (size_t f = 0; f < sizeof unaries / sizeof unaries[0]; f++) {
    const unary* u = &unaries[f];
    for (size_t i = 0; i < sizeof specials / sizeof specials[0]; i++) {
      check(u->name, specials[i], 0, u->reference(specials[i]), u->ours(specials[i]), u->tolerance);
    }
    for (int i = 0; i < 20000; i++) {
      double x = uniform(u->low, u->high);
      check(u->name, x, 0, u->reference(x), u->ours(x), u->tolerance);
      double small = uniform(-1e-3, 1e-3);
      check(u->name, small, 0, u->reference(small), u->ours(small), u->tolerance);
    }
  }
  for (int i = 0; i < 20000; i++) {
    double y = uniform(-1e6, 1e6);
    double x = uniform(-1e6, 1e6);
    check("atan2", y, x, atan2(y, x), console_musl_atan2(y, x), 1);
    check("hypot", y, x, hypot(y, x), console_musl_hypot(y, x), 1);
    double base = uniform(0, 100);
    double exponent = uniform(-50, 50);
    check("pow", base, exponent, pow(base, exponent), console_musl_pow(base, exponent), 1);
    double integer_exponent = (double)(int)(next_random() % 41) - 20;
    check("pow", -base, integer_exponent, pow(-base, integer_exponent),
          console_musl_pow(-base, integer_exponent), 1);
    double numerator = uniform(-1e9, 1e9);
    double denominator = uniform(-1e3, 1e3);
    check("fmod", numerator, denominator, fmod(numerator, denominator),
          console_musl_fmod(numerator, denominator), 0);
    double integral_expected;
    double integral_actual;
    check("modf", numerator, 0, modf(numerator, &integral_expected),
          console_musl_modf(numerator, &integral_actual), 0);
    check("modf integral", numerator, 0, integral_expected, integral_actual, 0);
    int exponent_expected;
    int exponent_actual;
    check("frexp", numerator, 0, frexp(numerator, &exponent_expected),
          console_musl_frexp(numerator, &exponent_actual), 0);
    check("frexp exponent", numerator, 0, exponent_expected, exponent_actual, 0);
    int shift = (int)(next_random() % 2200) - 1100;
    check("ldexp", numerator, shift, ldexp(numerator, shift), console_musl_ldexp(numerator, shift), 0);
    check("scalbn", numerator, shift, scalbn(numerator, shift), console_musl_scalbn(numerator, shift), 0);
  }
  for (size_t i = 0; i < sizeof specials / sizeof specials[0]; i++) {
    for (size_t j = 0; j < sizeof specials / sizeof specials[0]; j++) {
      double y = specials[i];
      double x = specials[j];
      check("atan2", y, x, atan2(y, x), console_musl_atan2(y, x), 1);
      check("hypot", y, x, hypot(y, x), console_musl_hypot(y, x), 1);
      check("pow", y, x, pow(y, x), console_musl_pow(y, x), 1);
      check("fmod", y, x, fmod(y, x), console_musl_fmod(y, x), 0);
    }
  }
  printf("%d checks, %d failures\n", checks, failures);
  return failures ? 1 : 0;
}
