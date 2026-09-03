// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// Moving, forwarding, swapping, and the pair every associative lookup answers
// with. The index sequences are here too, because that is where <tuple> and
// anything else that unpacks a parameter pack looks for them.

#ifndef CONSOLE_CXX_UTILITY
#define CONSOLE_CXX_UTILITY

#include <stddef.h>

#include <type_traits>

namespace std {

template <typename T>
constexpr remove_reference_t<T>&& move(T&& value) noexcept {
    return static_cast<remove_reference_t<T>&&>(value);
}

template <typename T>
constexpr T&& forward(remove_reference_t<T>& value) noexcept {
    return static_cast<T&&>(value);
}

template <typename T>
constexpr T&& forward(remove_reference_t<T>&& value) noexcept {
    static_assert(!is_lvalue_reference_v<T>, "an rvalue cannot be forwarded as an lvalue");
    return static_cast<T&&>(value);
}

template <typename T>
constexpr const T& as_const(T& value) noexcept {
    return value;
}
template <typename T>
void as_const(const T&&) = delete;

template <typename T>
inline void swap(T& left, T& right) noexcept(is_nothrow_move_constructible_v<T> &&
                                             is_nothrow_move_assignable<T>::value) {
    T held = move(left);
    left = move(right);
    right = move(held);
}

template <typename T, size_t N>
inline void swap(T (&left)[N], T (&right)[N]) noexcept(noexcept(swap(*left, *right))) {
    for (size_t i = 0; i < N; ++i) swap(left[i], right[i]);
}

template <typename T, typename U = T>
inline T exchange(T& target, U&& replacement) {
    T previous = move(target);
    target = forward<U>(replacement);
    return previous;
}

// The tag that says the arguments are for the held object rather than for a
// copy of one, which is how <optional> is told to build in place.
struct in_place_t {
    explicit in_place_t() = default;
};
inline constexpr in_place_t in_place{};

template <typename T>
struct in_place_type_t {
    explicit in_place_type_t() = default;
};

template <size_t I>
struct in_place_index_t {
    explicit in_place_index_t() = default;
};

template <typename First, typename Second>
struct pair {
    using first_type = First;
    using second_type = Second;

    First first;
    Second second;

    constexpr pair() : first(), second() {}
    constexpr pair(const First& one, const Second& two) : first(one), second(two) {}

    template <typename U1, typename U2>
    constexpr pair(U1&& one, U2&& two)
        : first(forward<U1>(one)), second(forward<U2>(two)) {}

    template <typename U1, typename U2>
    constexpr pair(const pair<U1, U2>& other) : first(other.first), second(other.second) {}

    template <typename U1, typename U2>
    constexpr pair(pair<U1, U2>&& other)
        : first(move(other.first)), second(move(other.second)) {}

    pair(const pair&) = default;
    pair(pair&&) = default;
    pair& operator=(const pair&) = default;
    pair& operator=(pair&&) = default;

    void swap(pair& other) {
        std::swap(first, other.first);
        std::swap(second, other.second);
    }
};

template <typename First, typename Second>
constexpr bool operator==(const pair<First, Second>& left, const pair<First, Second>& right) {
    return left.first == right.first && left.second == right.second;
}

template <typename First, typename Second>
constexpr bool operator!=(const pair<First, Second>& left, const pair<First, Second>& right) {
    return !(left == right);
}

template <typename First, typename Second>
constexpr bool operator<(const pair<First, Second>& left, const pair<First, Second>& right) {
    if (left.first < right.first) return true;
    if (right.first < left.first) return false;
    return left.second < right.second;
}

template <typename First, typename Second>
constexpr bool operator>(const pair<First, Second>& left, const pair<First, Second>& right) {
    return right < left;
}

template <typename First, typename Second>
constexpr bool operator<=(const pair<First, Second>& left, const pair<First, Second>& right) {
    return !(right < left);
}

template <typename First, typename Second>
constexpr bool operator>=(const pair<First, Second>& left, const pair<First, Second>& right) {
    return !(left < right);
}

template <typename First, typename Second>
constexpr pair<decay_t<First>, decay_t<Second>> make_pair(First&& one, Second&& two) {
    return pair<decay_t<First>, decay_t<Second>>(forward<First>(one), forward<Second>(two));
}

template <typename First, typename Second>
inline void swap(pair<First, Second>& left, pair<First, Second>& right) {
    left.swap(right);
}

// The compiler builds the list of indices itself; spelling it as a recursion
// here would cost a template instantiation per element.
template <typename T, T... Values>
struct integer_sequence {
    using value_type = T;
    static constexpr size_t size() noexcept { return sizeof...(Values); }
};

template <typename T, T Count>
using make_integer_sequence = __make_integer_seq<integer_sequence, T, Count>;

template <size_t... Values>
using index_sequence = integer_sequence<size_t, Values...>;

template <size_t Count>
using make_index_sequence = make_integer_sequence<size_t, Count>;

template <typename... Ts>
using index_sequence_for = make_index_sequence<sizeof...(Ts)>;

}  // namespace std

#endif
