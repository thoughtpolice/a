/* SPDX-FileCopyrightText: 2026 Austin Seipp
 * SPDX-License-Identifier: Apache-2.0 */
#include <stdio.h>
#include <stdint.h>
#define CHECK(x) do { if (!(x)) { fprintf(stderr, "C++ check failed at %d\n", __LINE__); return 1; } } while (0)

template<unsigned N> struct factorial { enum { value = N * factorial<N-1>::value }; };
template<> struct factorial<0> { enum { value = 1 }; };
template<class T> T sum(T x) { return x; }
template<class T, class... Rest> T sum(T x, Rest... rest) { return x + sum(rest...); }
constexpr unsigned square(unsigned x) { return x*x; }
static_assert(factorial<6>::value == 720 && square(13) == 169, "constant evaluation");

struct left { virtual long value() const { return 3; } long a; };
struct right { virtual long value() const { return 5; } long b; };
struct derived : left, right { long value() const { return 0x123456789L; } };
static __attribute__((noinline)) long dispatch(const right& x) { return x.value(); }
static int live;
struct lifetime { lifetime() { ++live; } ~lifetime() { --live; } };
enum class color : unsigned char { red = 7, blue = 11 };

int main() {
    derived d;
    CHECK(dispatch(d) == 0x123456789L);
    CHECK(static_cast<const void *>(static_cast<right *>(&d)) != static_cast<const void *>(&d));
    CHECK(sum(1L, 2L, 3L, 4L, 5L) == 15);
    int values[] = {1, 2, 3, 4}, total = 0;
    for (auto x : values) total += [x](int n) { return x*n; }(3);
    CHECK(total == 30);
    { lifetime a; { lifetime b; CHECK(live == 2); } CHECK(live == 1); }
    CHECK(live == 0 && static_cast<unsigned>(color::blue) == 11);
    uint64_t counter __attribute__((aligned(16))) = 9;
    CHECK(__atomic_fetch_add(&counter, 7, __ATOMIC_SEQ_CST) == 9);
    uint64_t expected = 16;
    CHECK(__atomic_compare_exchange_n(&counter, &expected, 23, false, __ATOMIC_SEQ_CST, __ATOMIC_SEQ_CST));
    CHECK(counter == 23);
    return 0;
}
