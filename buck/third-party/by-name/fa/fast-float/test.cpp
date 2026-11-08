// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// Parse numbers that are hard to round correctly, and reject what isn't one.

#include <cstdio>
#include <cstring>
#include <fast_float/fast_float.h>
#include <limits>
#include <system_error>

static bool parses(const char *s, double expect) {
    double d = 0;
    auto r = fast_float::from_chars(s, s + std::strlen(s), d);
    return r.ec == std::errc() && r.ptr == s + std::strlen(s) && d == expect;
}

int main() {
    if (!parses("3.1415926535897932384626433832795", 3.141592653589793)) return std::puts("pi"), 1;
    // Halfway between two doubles: rounds to even.
    if (!parses("9007199254740993", 9007199254740992.0)) return std::puts("round to even"), 1;
    if (!parses("2.2250738585072014e-308", 2.2250738585072014e-308)) return std::puts("subnormal edge"), 1;
    // Too large for a double: infinity, reported as out of range.
    double big = 0;
    const char *e400 = "1e400";
    if (fast_float::from_chars(e400, e400 + 5, big).ec != std::errc::result_out_of_range ||
        big != std::numeric_limits<double>::infinity())
        return std::puts("overflow"), 1;

    const char *bad = "nope";
    double d;
    if (fast_float::from_chars(bad, bad + 4, d).ec != std::errc::invalid_argument) return std::puts("accepted junk"), 1;

    int i = 0;
    const char *n = "-12345";
    if (fast_float::from_chars(n, n + 6, i).ec != std::errc() || i != -12345) return std::puts("integer"), 1;
    return 0;
}
