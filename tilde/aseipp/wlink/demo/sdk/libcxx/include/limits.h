// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// What the arithmetic types can hold, as values rather than as the macros
// <climits> spells the same bounds with. The compiler knows all of it
// already: every number below is one of its own predefined macros.

#ifndef CONSOLE_CXX_LIMITS
#define CONSOLE_CXX_LIMITS

#include <climits>

namespace std {

enum float_round_style {
    round_indeterminate = -1,
    round_toward_zero = 0,
    round_to_nearest = 1,
    round_toward_infinity = 2,
    round_toward_neg_infinity = 3,
};

enum float_denorm_style {
    denorm_indeterminate = -1,
    denorm_absent = 0,
    denorm_present = 1,
};

// The unspecialised template answers for a type that is not a number, which
// is what is_specialized being false says.
template <typename T>
struct numeric_limits {
    static constexpr bool is_specialized = false;

    static constexpr T min() noexcept { return T(); }
    static constexpr T max() noexcept { return T(); }
    static constexpr T lowest() noexcept { return T(); }

    static constexpr int digits = 0;
    static constexpr int digits10 = 0;
    static constexpr int max_digits10 = 0;
    static constexpr bool is_signed = false;
    static constexpr bool is_integer = false;
    static constexpr bool is_exact = false;
    static constexpr int radix = 0;

    static constexpr T epsilon() noexcept { return T(); }
    static constexpr T round_error() noexcept { return T(); }

    static constexpr int min_exponent = 0;
    static constexpr int min_exponent10 = 0;
    static constexpr int max_exponent = 0;
    static constexpr int max_exponent10 = 0;

    static constexpr bool has_infinity = false;
    static constexpr bool has_quiet_NaN = false;
    static constexpr bool has_signaling_NaN = false;
    static constexpr float_denorm_style has_denorm = denorm_absent;
    static constexpr bool has_denorm_loss = false;

    static constexpr T infinity() noexcept { return T(); }
    static constexpr T quiet_NaN() noexcept { return T(); }
    static constexpr T signaling_NaN() noexcept { return T(); }
    static constexpr T denorm_min() noexcept { return T(); }

    static constexpr bool is_iec559 = false;
    static constexpr bool is_bounded = false;
    static constexpr bool is_modulo = false;
    static constexpr bool traps = false;
    static constexpr bool tinyness_before = false;
    static constexpr float_round_style round_style = round_toward_zero;
};

template <typename T>
struct numeric_limits<const T> : numeric_limits<T> {};
template <typename T>
struct numeric_limits<volatile T> : numeric_limits<T> {};
template <typename T>
struct numeric_limits<const volatile T> : numeric_limits<T> {};

// An integer type is described entirely by its width, its sign, and its
// bounds, so one macro covers every one of them.
#define CONSOLE_INTEGER_LIMITS(type, signed_type, lowest_value, highest_value)          \
    template <>                                                                         \
    struct numeric_limits<type> {                                                       \
        static constexpr bool is_specialized = true;                                    \
                                                                                        \
        static constexpr type min() noexcept { return lowest_value; }                   \
        static constexpr type max() noexcept { return highest_value; }                  \
        static constexpr type lowest() noexcept { return lowest_value; }                \
                                                                                        \
        static constexpr int digits = static_cast<int>(sizeof(type) * CHAR_BIT) -       \
                                      (signed_type ? 1 : 0);                            \
        /* Every 10 bits are very nearly 3 decimal digits, and this is how the   */     \
        /* standard's floor(digits * log10(2)) is spelled without a log10.       */     \
        static constexpr int digits10 = digits * 643 / 2136;                            \
        static constexpr int max_digits10 = 0;                                          \
        static constexpr bool is_signed = signed_type;                                  \
        static constexpr bool is_integer = true;                                        \
        static constexpr bool is_exact = true;                                          \
        static constexpr int radix = 2;                                                 \
                                                                                        \
        static constexpr type epsilon() noexcept { return 0; }                          \
        static constexpr type round_error() noexcept { return 0; }                      \
                                                                                        \
        static constexpr int min_exponent = 0;                                          \
        static constexpr int min_exponent10 = 0;                                        \
        static constexpr int max_exponent = 0;                                          \
        static constexpr int max_exponent10 = 0;                                        \
                                                                                        \
        static constexpr bool has_infinity = false;                                     \
        static constexpr bool has_quiet_NaN = false;                                    \
        static constexpr bool has_signaling_NaN = false;                                \
        static constexpr float_denorm_style has_denorm = denorm_absent;                 \
        static constexpr bool has_denorm_loss = false;                                  \
                                                                                        \
        static constexpr type infinity() noexcept { return 0; }                         \
        static constexpr type quiet_NaN() noexcept { return 0; }                        \
        static constexpr type signaling_NaN() noexcept { return 0; }                    \
        static constexpr type denorm_min() noexcept { return 0; }                       \
                                                                                        \
        static constexpr bool is_iec559 = false;                                        \
        static constexpr bool is_bounded = true;                                        \
        static constexpr bool is_modulo = !signed_type;                                 \
        static constexpr bool traps = false;                                            \
        static constexpr bool tinyness_before = false;                                  \
        static constexpr float_round_style round_style = round_toward_zero;             \
    }

template <>
struct numeric_limits<bool> {
    static constexpr bool is_specialized = true;

    static constexpr bool min() noexcept { return false; }
    static constexpr bool max() noexcept { return true; }
    static constexpr bool lowest() noexcept { return false; }

    static constexpr int digits = 1;
    static constexpr int digits10 = 0;
    static constexpr int max_digits10 = 0;
    static constexpr bool is_signed = false;
    static constexpr bool is_integer = true;
    static constexpr bool is_exact = true;
    static constexpr int radix = 2;

    static constexpr bool epsilon() noexcept { return false; }
    static constexpr bool round_error() noexcept { return false; }

    static constexpr int min_exponent = 0;
    static constexpr int min_exponent10 = 0;
    static constexpr int max_exponent = 0;
    static constexpr int max_exponent10 = 0;

    static constexpr bool has_infinity = false;
    static constexpr bool has_quiet_NaN = false;
    static constexpr bool has_signaling_NaN = false;
    static constexpr float_denorm_style has_denorm = denorm_absent;
    static constexpr bool has_denorm_loss = false;

    static constexpr bool infinity() noexcept { return false; }
    static constexpr bool quiet_NaN() noexcept { return false; }
    static constexpr bool signaling_NaN() noexcept { return false; }
    static constexpr bool denorm_min() noexcept { return false; }

    static constexpr bool is_iec559 = false;
    static constexpr bool is_bounded = true;
    static constexpr bool is_modulo = false;
    static constexpr bool traps = false;
    static constexpr bool tinyness_before = false;
    static constexpr float_round_style round_style = round_toward_zero;
};

// <climits> stops at the types C has. The three C++ adds are bounded by the
// compiler's own macros for them instead.
#ifdef __WCHAR_UNSIGNED__
#  define CONSOLE_WCHAR_MIN 0
#  define CONSOLE_WCHAR_SIGNED false
#else
#  define CONSOLE_WCHAR_MIN (-__WCHAR_MAX__ - 1)
#  define CONSOLE_WCHAR_SIGNED true
#endif

CONSOLE_INTEGER_LIMITS(char, (CHAR_MIN != 0), CHAR_MIN, CHAR_MAX);
CONSOLE_INTEGER_LIMITS(signed char, true, SCHAR_MIN, SCHAR_MAX);
CONSOLE_INTEGER_LIMITS(unsigned char, false, 0, UCHAR_MAX);
CONSOLE_INTEGER_LIMITS(wchar_t, CONSOLE_WCHAR_SIGNED, CONSOLE_WCHAR_MIN, __WCHAR_MAX__);
CONSOLE_INTEGER_LIMITS(char16_t, false, 0, __UINT_LEAST16_MAX__);
CONSOLE_INTEGER_LIMITS(char32_t, false, 0, __UINT_LEAST32_MAX__);
CONSOLE_INTEGER_LIMITS(short, true, SHRT_MIN, SHRT_MAX);
CONSOLE_INTEGER_LIMITS(unsigned short, false, 0, USHRT_MAX);
CONSOLE_INTEGER_LIMITS(int, true, INT_MIN, INT_MAX);
CONSOLE_INTEGER_LIMITS(unsigned int, false, 0, UINT_MAX);
CONSOLE_INTEGER_LIMITS(long, true, LONG_MIN, LONG_MAX);
CONSOLE_INTEGER_LIMITS(unsigned long, false, 0, ULONG_MAX);
CONSOLE_INTEGER_LIMITS(long long, true, LLONG_MIN, LLONG_MAX);
CONSOLE_INTEGER_LIMITS(unsigned long long, false, 0, ULLONG_MAX);

#undef CONSOLE_INTEGER_LIMITS
#undef CONSOLE_WCHAR_MIN
#undef CONSOLE_WCHAR_SIGNED

// The floating point types, which the target has in IEEE 754 form. Every
// bound is the compiler's own macro for it, so these say what this target
// does rather than what a float usually is.
#define CONSOLE_FLOAT_LIMITS(type, suffix, digits_, digits10_, max_digits10_,           \
                             min_exponent_, min_exponent10_, max_exponent_,             \
                             max_exponent10_, min_, max_, epsilon_, denorm_min_)        \
    template <>                                                                         \
    struct numeric_limits<type> {                                                       \
        static constexpr bool is_specialized = true;                                    \
                                                                                        \
        static constexpr type min() noexcept { return min_; }                           \
        static constexpr type max() noexcept { return max_; }                           \
        static constexpr type lowest() noexcept { return -max_; }                       \
                                                                                        \
        static constexpr int digits = digits_;                                          \
        static constexpr int digits10 = digits10_;                                      \
        static constexpr int max_digits10 = max_digits10_;                              \
        static constexpr bool is_signed = true;                                         \
        static constexpr bool is_integer = false;                                       \
        static constexpr bool is_exact = false;                                         \
        static constexpr int radix = 2;                                                 \
                                                                                        \
        static constexpr type epsilon() noexcept { return epsilon_; }                   \
        static constexpr type round_error() noexcept { return 0.5##suffix; }            \
                                                                                        \
        static constexpr int min_exponent = min_exponent_;                              \
        static constexpr int min_exponent10 = min_exponent10_;                          \
        static constexpr int max_exponent = max_exponent_;                              \
        static constexpr int max_exponent10 = max_exponent10_;                          \
                                                                                        \
        static constexpr bool has_infinity = true;                                      \
        static constexpr bool has_quiet_NaN = true;                                     \
        static constexpr bool has_signaling_NaN = true;                                 \
        static constexpr float_denorm_style has_denorm = denorm_present;                \
        static constexpr bool has_denorm_loss = false;                                  \
                                                                                        \
        static constexpr type infinity() noexcept { return __builtin_inf##suffix(); }   \
        static constexpr type quiet_NaN() noexcept { return __builtin_nan##suffix(""); }\
        static constexpr type signaling_NaN() noexcept {                                \
            return __builtin_nans##suffix("");                                          \
        }                                                                               \
        static constexpr type denorm_min() noexcept { return denorm_min_; }             \
                                                                                        \
        static constexpr bool is_iec559 = true;                                         \
        static constexpr bool is_bounded = true;                                        \
        static constexpr bool is_modulo = false;                                        \
        static constexpr bool traps = false;                                            \
        static constexpr bool tinyness_before = false;                                  \
        static constexpr float_round_style round_style = round_to_nearest;              \
    }

CONSOLE_FLOAT_LIMITS(float, f, __FLT_MANT_DIG__, __FLT_DIG__, __FLT_DECIMAL_DIG__,
                     __FLT_MIN_EXP__, __FLT_MIN_10_EXP__, __FLT_MAX_EXP__,
                     __FLT_MAX_10_EXP__, __FLT_MIN__, __FLT_MAX__, __FLT_EPSILON__,
                     __FLT_DENORM_MIN__);
CONSOLE_FLOAT_LIMITS(double, , __DBL_MANT_DIG__, __DBL_DIG__, __DBL_DECIMAL_DIG__,
                     __DBL_MIN_EXP__, __DBL_MIN_10_EXP__, __DBL_MAX_EXP__,
                     __DBL_MAX_10_EXP__, __DBL_MIN__, __DBL_MAX__, __DBL_EPSILON__,
                     __DBL_DENORM_MIN__);
CONSOLE_FLOAT_LIMITS(long double, l, __LDBL_MANT_DIG__, __LDBL_DIG__,
                     __LDBL_DECIMAL_DIG__, __LDBL_MIN_EXP__, __LDBL_MIN_10_EXP__,
                     __LDBL_MAX_EXP__, __LDBL_MAX_10_EXP__, __LDBL_MIN__, __LDBL_MAX__,
                     __LDBL_EPSILON__, __LDBL_DENORM_MIN__);

#undef CONSOLE_FLOAT_LIMITS

}  // namespace std

#endif
