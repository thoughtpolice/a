/* SPDX-FileCopyrightText: 2026 Austin Seipp
 * SPDX-License-Identifier: MIT */
#include "exception.h"
#include <cassert>
#include <cstdlib>
#include <cxxabi.h>
#include <cstring>
#include <new>
#include <typeinfo>

static int destroyed;
struct Verify { ~Verify() { if (destroyed != 3) std::abort(); } } verify;
struct Global { ~Global() { ++destroyed; } } first, second, third;
int main()
{
    int cleaned = 0;
    try { throw_separately(&cleaned); }
    catch (const Right& base) {
        const Derived *d = dynamic_cast<const Derived *>(&base);
        assert(d && d->value == 42 && cleaned == 1);
        assert(typeid(base) == typeid(Derived));
    }
    int *values = new int[10];
    for (int i = 0; i < 10; ++i) values[i] = i;
    assert(values[9] == 9); delete[] values;
    int status;
    char *name = abi::__cxa_demangle("_Z3fooi", 0, 0, &status);
    assert(status == 0 && !std::strcmp(name, "foo(int)"));
    std::free(name);
    assert(destroyed == 0);
}
