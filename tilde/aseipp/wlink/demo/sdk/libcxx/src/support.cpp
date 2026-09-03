// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// The runtime a freestanding C++ guest needs underneath the containers: the
// allocation operators, and the few symbols the compiler emits references to
// on its own.

#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#include <exception>
#include <new>
#include <string_view>

#include "console.h"

namespace std {

[[noreturn]] void __console_cxx_fail(const char* what) {
    console_log(CONSOLE_SDK_LOG_LEVEL_ERROR, what, strlen(what));
    console_process_exit(1);
}

}  // namespace std

// Declared by <new>, defined in the library built for the host.
namespace std {
const nothrow_t nothrow{};
}  // namespace std

void* operator new(size_t size) {
    void* memory = malloc(size ? size : 1);
    if (!memory) std::__console_cxx_fail("out of memory");
    return memory;
}

void* operator new[](size_t size) { return operator new(size); }

void* operator new(size_t size, const std::nothrow_t&) noexcept { return malloc(size ? size : 1); }
void* operator new[](size_t size, const std::nothrow_t&) noexcept { return operator new(size, std::nothrow); }

void operator delete(void* memory) noexcept { free(memory); }
void operator delete[](void* memory) noexcept { free(memory); }
void operator delete(void* memory, size_t) noexcept { free(memory); }
void operator delete[](void* memory, size_t) noexcept { free(memory); }
void operator delete(void* memory, const std::nothrow_t&) noexcept { free(memory); }
void operator delete[](void* memory, const std::nothrow_t&) noexcept { free(memory); }

extern "C" {

// Emitted into the vtable of an abstract class; reaching it means a call on a
// partly destroyed object, which no guest can carry on from.
void __cxa_pure_virtual(void) { std::__console_cxx_fail("pure virtual function called"); }

void __cxa_deleted_virtual(void) { std::__console_cxx_fail("deleted virtual function called"); }

// Guards for function-local statics. The console runs a guest on one thread,
// so the guard is a plain flag and initialisation can never be contended.
int __cxa_guard_acquire(uint64_t* guard) { return *reinterpret_cast<char*>(guard) == 0; }
void __cxa_guard_release(uint64_t* guard) { *reinterpret_cast<char*>(guard) = 1; }
void __cxa_guard_abort(uint64_t*) {}

// Destructors for objects with static storage. Nothing tears a guest down in
// an order that could run them, so they are recorded and never called.
int __cxa_atexit(void (*)(void*), void*, void*) { return 0; }

}  // extern "C"

// What std::hash is underneath, declared by <string_view>. FNV-1a over the
// bytes: nothing outside one run ever sees these values, so all that is asked
// of it is that it spread them.
namespace std {
namespace __console {

size_t hash_bytes(const void* bytes, size_t length) noexcept {
    const unsigned char* at = static_cast<const unsigned char*>(bytes);
    size_t hash = 0x811c9dc5u;
    for (size_t i = 0; i < length; ++i) {
        hash ^= at[i];
        hash *= 0x01000193u;
    }
    return hash;
}

}  // namespace __console
}  // namespace std

// The standard exception base, whose vtable must exist somewhere even when no
// guest ever constructs one.
namespace std {
exception::~exception() noexcept {}
const char* exception::what() const noexcept { return "exception"; }
}  // namespace std
