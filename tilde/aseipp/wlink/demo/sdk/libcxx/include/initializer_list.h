// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// The type a braced list becomes. The compiler builds one of these directly
// out of the array it laid down, so the layout below is fixed by it: a
// pointer and a count, in that order, under these names.

#ifndef CONSOLE_CXX_INITIALIZER_LIST
#define CONSOLE_CXX_INITIALIZER_LIST

#include <stddef.h>

namespace std {

template <typename T>
class initializer_list {
public:
    using value_type = T;
    using reference = const T&;
    using const_reference = const T&;
    using size_type = size_t;
    using iterator = const T*;
    using const_iterator = const T*;

    constexpr initializer_list() noexcept : first_(nullptr), size_(0) {}

    constexpr size_type size() const noexcept { return size_; }
    constexpr const T* begin() const noexcept { return first_; }
    constexpr const T* end() const noexcept { return first_ + size_; }

private:
    // Never called: the compiler writes the two members itself. It is here so
    // that nothing else can make a list that does not point at an array.
    constexpr initializer_list(const T* first, size_type size) noexcept
        : first_(first), size_(size) {}

    const T* first_;
    size_type size_;
};

template <typename T>
constexpr const T* begin(initializer_list<T> values) noexcept {
    return values.begin();
}

template <typename T>
constexpr const T* end(initializer_list<T> values) noexcept {
    return values.end();
}

}  // namespace std

#endif
