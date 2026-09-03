// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// C++ exceptions as a guest throws them, on the console's own runtime: what
// a handler catches, what it does not, what runs on the way out of a scope,
// and what happens to an exception that is thrown onwards.

#include <setjmp.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include <stdexcept>
#include <string>
#include <vector>

#include "runtime.h"

namespace {

void require(bool condition, const char* what) {
    if (!condition) {
        printf("FAIL libcxx %s\n", what);
        exit(1);
    }
}

struct Simple {
    int code;
};

struct Base {
    virtual ~Base() = default;
    int tag = 1;
};

struct Derived : Base {
    int extra = 2;
};

// Counts its own lifetime, so unwinding can be checked rather than assumed.
int live_marks = 0;
int destroyed_marks = 0;

struct Mark {
    Mark() { live_marks += 1; }
    Mark(const Mark&) { live_marks += 1; }
    ~Mark() {
        live_marks -= 1;
        destroyed_marks += 1;
    }
};

void throw_simple(int code) { throw Simple{code}; }
void throw_derived() { throw Derived{}; }
void throw_int() { throw 42; }
void throw_runtime(const char* what) { throw std::runtime_error(what); }

void test_basic() {
    int caught = 0;
    try {
        throw_simple(7);
    } catch (const Simple& oops) {
        caught = oops.code;
    }
    require(caught == 7, "a handler catches the type it names");

    // The handler whose type matches is the one that runs, whichever comes
    // first in the source.
    int which = 0;
    try {
        throw_simple(3);
    } catch (const std::runtime_error&) {
        which = 1;
    } catch (const Simple&) {
        which = 2;
    } catch (...) {
        which = 3;
    }
    require(which == 2, "the handler that matches runs, not the first one");

    // A type nothing names is taken by the catch-all.
    which = 0;
    try {
        throw_int();
    } catch (const Simple&) {
        which = 1;
    } catch (...) {
        which = 2;
    }
    require(which == 2, "a catch-all takes what no handler names");

    // Fundamentals are caught by value, by their own type.
    int value = 0;
    try {
        throw_int();
    } catch (int caught_value) {
        value = caught_value;
    }
    require(value == 42, "a fundamental type is caught by its own type");
    printf("PASS libcxx throw\n");
}

void test_hierarchy() {
    // A handler for a base class takes an exception of a class derived from
    // it, and is given the base to look at.
    int tag = 0;
    try {
        throw_derived();
    } catch (const Base& base) {
        tag = base.tag;
    }
    require(tag == 1, "a base class handler catches a derived exception");

    // The same, through the standard hierarchy the SDK ships.
    std::string message;
    try {
        throw_runtime("the cart is on fire");
    } catch (const std::exception& error) {
        message = error.what();
    }
    require(message == "the cart is on fire", "std::exception catches std::runtime_error");

    // A derived handler does not catch its base.
    int which = 0;
    try {
        throw Base{};
    } catch (const Derived&) {
        which = 1;
    } catch (const Base&) {
        which = 2;
    }
    require(which == 2, "a derived handler does not catch a base exception");
    printf("PASS libcxx hierarchy\n");
}

void test_unwinding() {
    live_marks = 0;
    destroyed_marks = 0;
    try {
        Mark outer;
        {
            Mark inner;
            require(live_marks == 2, "both marks are alive inside the scope");
            throw_simple(1);
        }
    } catch (const Simple&) {
        require(live_marks == 0, "leaving a scope by throwing still destroys it");
        require(destroyed_marks == 2, "every object in the scope was destroyed");
    }

    // Containers holding their memory across a throw give it back.
    live_marks = 0;
    destroyed_marks = 0;
    try {
        std::vector<Mark> marks;
        marks.push_back(Mark());
        marks.push_back(Mark());
        require(live_marks == 2, "the vector holds two marks");
        throw_simple(2);
    } catch (const Simple&) {
        require(live_marks == 0, "the vector was destroyed on the way out");
    }
    printf("PASS libcxx unwinding\n");
}

void test_rethrow() {
    int outer_code = 0;
    int inner_code = 0;
    try {
        try {
            throw_simple(11);
        } catch (const Simple& oops) {
            inner_code = oops.code;
            // The same exception continues outwards rather than a new one.
            throw;
        }
    } catch (const Simple& oops) {
        outer_code = oops.code;
    }
    require(inner_code == 11 && outer_code == 11, "a rethrow carries the same exception on");

    // An exception thrown from inside a handler replaces it.
    int replaced = 0;
    try {
        try {
            throw_simple(1);
        } catch (const Simple&) {
            throw_int();
        }
    } catch (int value) {
        replaced = value;
    }
    require(replaced == 42, "a handler may throw something else");
    printf("PASS libcxx rethrow\n");
}

void test_nesting() {
    // Handlers nest, and the inner one does not swallow what it cannot take.
    int order = 0;
    try {
        try {
            throw_int();
        } catch (const Simple&) {
            order = 1;
        }
        order = 2;
    } catch (int) {
        order = order * 10 + 3;
    }
    require(order == 3, "an exception passes a handler that does not name it");

    // A jump and a throw are the same mechanism underneath, and nesting one
    // inside the other has to keep them apart.
    volatile int stage = 0;
    try {
        jmp_buf jump;
        if (setjmp(jump) == 0) {
            stage = 1;
            longjmp(jump, 5);
        }
        stage = 2;
        throw_simple(9);
    } catch (const Simple& oops) {
        stage = 3 + oops.code;
    }
    require(stage == 12, "a throw out of a frame that has jumped still lands");
    printf("PASS libcxx nesting\n");
}

}  // namespace

extern "C" void console_guest_init(void) {
    test_basic();
    test_hierarchy();
    test_unwinding();
    test_rethrow();
    test_nesting();
    printf("PASS libcxx exceptions\n");
    exit(0);
}

extern "C" int32_t console_guest_frame(uint32_t dt_ms) {
    (void)dt_ms;
    return 0;
}
