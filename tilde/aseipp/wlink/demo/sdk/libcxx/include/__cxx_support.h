// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// Shared plumbing for the containers this library supplies. The compiler's
// own freestanding C++ headers provide everything else, so only the pieces
// GCC marks as hosted are defined here, in the namespace they belong to.

#ifndef CONSOLE_CXX_SUPPORT
#define CONSOLE_CXX_SUPPORT

#include <stddef.h>
#include <stdint.h>

#include <initializer_list>
#include <new>
#include <type_traits>
#include <utility>

namespace std {

// Reported through the console log before the guest is stopped: a container
// that has run out of memory or been indexed out of range cannot continue,
// and the SDK has no exceptions to unwind with.
[[noreturn]] void __console_cxx_fail(const char* what);

namespace __console {

inline void* allocate(size_t bytes) {
    void* memory = ::operator new(bytes, nothrow);
    if (!memory) __console_cxx_fail("out of memory");
    return memory;
}

inline void deallocate(void* memory) noexcept { ::operator delete(memory); }

// Half again on every growth, which keeps push_back amortised constant
// without the doubling that a 32-bit address space cannot afford twice over.
inline size_t grow(size_t capacity, size_t least) {
    size_t next = capacity + capacity / 2 + 8;
    return next < least ? least : next;
}

template <typename T>
inline void destroy(T* first, T* last) noexcept {
    if constexpr (!is_trivially_destructible<T>::value)
        for (; first != last; ++first) first->~T();
}

// Moved rather than copied when the type allows it, and the source is left
// destructible so the caller can release the old block unconditionally.
template <typename T>
inline void relocate(T* to, T* first, T* last) {
    for (; first != last; ++first, ++to) {
        ::new (static_cast<void*>(to)) T(move(*first));
        first->~T();
    }
}

}  // namespace __console
}  // namespace std

#endif
