// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

#ifndef CONSOLE_LIBC_MATH_H
#define CONSOLE_LIBC_MATH_H

#ifdef __cplusplus
extern "C" {
#endif

typedef float float_t;
typedef double double_t;

#define M_E 2.7182818284590452354
#define M_LN2 0.69314718055994530942
#define M_LN10 2.30258509299404568402
#define M_PI 3.14159265358979323846
#define M_PI_2 1.57079632679489661923
#define M_PI_4 0.78539816339744830962
#define M_1_PI 0.31830988618379067154
#define M_2_PI 0.63661977236758134308
#define M_SQRT2 1.41421356237309504880
#define M_SQRT1_2 0.70710678118654752440

#define HUGE_VAL __builtin_huge_val()
#define HUGE_VALF __builtin_huge_valf()
#define INFINITY __builtin_inff()
#define NAN __builtin_nanf("")

#define isnan(value) __builtin_isnan(value)
#define isinf(value) __builtin_isinf(value)
#define isfinite(value) __builtin_isfinite(value)
#define isnormal(value) __builtin_isnormal(value)
#define signbit(value) __builtin_signbit(value)

// WebAssembly has instructions for these; the compiler emits them from the
// builtins even though freestanding mode never recognizes the library names.
static inline double sqrt(double value) { return __builtin_sqrt(value); }
static inline float sqrtf(float value) { return __builtin_sqrtf(value); }
static inline double fabs(double value) { return __builtin_fabs(value); }
static inline float fabsf(float value) { return __builtin_fabsf(value); }
static inline double floor(double value) { return __builtin_floor(value); }
static inline float floorf(float value) { return __builtin_floorf(value); }
static inline double ceil(double value) { return __builtin_ceil(value); }
static inline float ceilf(float value) { return __builtin_ceilf(value); }
static inline double trunc(double value) { return __builtin_trunc(value); }
static inline float truncf(float value) { return __builtin_truncf(value); }
static inline double rint(double value) { return __builtin_rint(value); }
static inline float rintf(float value) { return __builtin_rintf(value); }
static inline double nearbyint(double value) { return __builtin_nearbyint(value); }
static inline double copysign(double value, double sign) { return __builtin_copysign(value, sign); }
static inline float copysignf(float value, float sign) { return __builtin_copysignf(value, sign); }
static inline double fmin(double left, double right) { return __builtin_fmin(left, right); }
static inline double fmax(double left, double right) { return __builtin_fmax(left, right); }
static inline float fminf(float left, float right) { return __builtin_fminf(left, right); }
static inline float fmaxf(float left, float right) { return __builtin_fmaxf(left, right); }

// Implemented by the musl routines in musl/.
double sin(double value);
double cos(double value);
double tan(double value);
double sinh(double value);
double cosh(double value);
double tanh(double value);
double expm1(double value);
double asin(double value);
double acos(double value);
double atan(double value);
double atan2(double y, double x);
double exp(double value);
double log(double value);
double log2(double value);
double log10(double value);
double pow(double base, double exponent);
double fmod(double numerator, double denominator);
double modf(double value, double* integral);
double frexp(double value, int* exponent);
double ldexp(double value, int exponent);
double scalbn(double value, int exponent);
double round(double value);
double cbrt(double value);
double hypot(double x, double y);

#ifdef __cplusplus
}
#endif

#endif
