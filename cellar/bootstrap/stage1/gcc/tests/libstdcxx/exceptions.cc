/* SPDX-FileCopyrightText: 2026 Austin Seipp
 * SPDX-License-Identifier: MIT */
#include "exception.h"
#include <cassert>
#include <cxxabi.h>
#include <cstring>
#include <cstdlib>
#include <exception>
#include <stdexcept>
#include <typeinfo>

static void __attribute__((noinline)) failed_cast(Left& plain)
{
    assert(!dynamic_cast<Derived *>(&plain));
    try { (void)dynamic_cast<Derived&>(plain); assert(false); }
    catch (const std::bad_cast&) {}
}

int main()
{
    int cleaned = 0;
    std::exception_ptr saved;
    try { throw_separately(&cleaned); }
    catch (const Right& r) {
        assert(cleaned == 1);
        const Derived *d = dynamic_cast<const Derived *>(&r);
        assert(d && d->value == 42);
        assert(typeid(r) == typeid(Derived));
        saved = std::current_exception();
    }
    assert(saved);
    try { std::rethrow_exception(saved); }
    catch (const Derived& d) { assert(d.value == 42); ++cleaned; }
    assert(cleaned == 2);
    Left plain;
    failed_cast(plain);
    Left *null = 0;
    try { (void)typeid(*null); assert(false); }
    catch (const std::bad_typeid&) {}
    try {
        try { throw std::runtime_error("inner"); }
        catch (...) { std::throw_with_nested(std::logic_error("outer")); }
    } catch (const std::logic_error& e) {
        assert(!std::strcmp(e.what(), "outer"));
        try { std::rethrow_if_nested(e); assert(false); }
        catch (const std::runtime_error& inner) {
            assert(!std::strcmp(inner.what(), "inner"));
            ++cleaned;
        }
    }
    assert(cleaned == 3);
    int status = 9;
    char *name = abi::__cxa_demangle("_Z3fooi", 0, 0, &status);
    assert(status == 0 && name && !std::strcmp(name, "foo(int)"));
    std::free(name);
    name = abi::__cxa_demangle("invalid", 0, 0, &status);
    assert(status == -2 && !name);
}
