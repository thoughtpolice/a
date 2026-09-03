// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// The SDK's math.h under the names C++ code expects. Its classification
// entries are macros, which cannot be named through a namespace, so they are
// re-formed as functions over the same builtins.

#ifndef CONSOLE_CXX_CMATH
#define CONSOLE_CXX_CMATH

#include <math.h>

#undef isnan
#undef isinf
#undef isfinite
#undef signbit

namespace std {

using ::acos;
using ::asin;
using ::atan;
using ::atan2;
using ::cbrt;
using ::ceil;
using ::cos;
using ::exp;
using ::fabs;
using ::floor;
using ::fmod;
using ::frexp;
using ::hypot;
using ::ldexp;
using ::log;
using ::log10;
using ::log2;
using ::modf;
using ::pow;
using ::round;
using ::scalbn;
using ::sin;
using ::sqrt;
using ::tan;

inline bool isnan(double value) { return __builtin_isnan(value); }
inline bool isnan(float value) { return __builtin_isnan(value); }
inline bool isinf(double value) { return __builtin_isinf(value); }
inline bool isinf(float value) { return __builtin_isinf(value); }
inline bool isfinite(double value) { return __builtin_isfinite(value); }
inline bool isfinite(float value) { return __builtin_isfinite(value); }
inline bool signbit(double value) { return __builtin_signbit(value); }
inline bool signbit(float value) { return __builtin_signbit(value); }

}  // namespace std

#define isnan(value) __builtin_isnan(value)
#define isinf(value) __builtin_isinf(value)
#define isfinite(value) __builtin_isfinite(value)
#define signbit(value) __builtin_signbit(value)

#endif
