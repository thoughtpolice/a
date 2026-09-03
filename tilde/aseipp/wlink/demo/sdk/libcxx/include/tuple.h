// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// A fixed group of values of different types, as a head and the rest of the
// group. Recursion is what makes get<I> and the element-wise assignment fall
// out without any index arithmetic over storage.

#ifndef CONSOLE_CXX_TUPLE
#define CONSOLE_CXX_TUPLE

#include <stddef.h>

#include <type_traits>
#include <utility>

namespace std {

template <typename... Ts>
class tuple;

template <>
class tuple<> {
public:
    tuple() = default;
    void swap(tuple&) noexcept {}
};

template <typename Head, typename... Tail>
class tuple<Head, Tail...> {
public:
    tuple() : head_(), tail_() {}

    explicit tuple(const Head& head, const Tail&... tail) : head_(head), tail_(tail...) {}

    template <typename UHead, typename... UTail,
              typename = enable_if_t<sizeof...(UTail) == sizeof...(Tail) &&
                                     !is_same_v<decay_t<UHead>, tuple>>>
    explicit tuple(UHead&& head, UTail&&... tail)
        : head_(forward<UHead>(head)), tail_(forward<UTail>(tail)...) {}

    template <typename... Us>
    tuple(const tuple<Us...>& other) : head_(other.__head()), tail_(other.__tail()) {}

    tuple(const tuple&) = default;
    tuple(tuple&&) = default;

    tuple& operator=(const tuple& other) {
        head_ = other.head_;
        tail_ = other.tail_;
        return *this;
    }

    tuple& operator=(tuple&& other) {
        head_ = move(other.head_);
        tail_ = move(other.tail_);
        return *this;
    }

    // What tie() is for: the left side holds references, so assigning a group
    // of values through it writes each one where it came from.
    template <typename... Us>
    tuple& operator=(const tuple<Us...>& other) {
        head_ = other.__head();
        tail_ = other.__tail();
        return *this;
    }

    // Reached from the other instantiations of this template, which are not
    // friends of one another, and from get<I> below.
    Head& __head() noexcept { return head_; }
    const Head& __head() const noexcept { return head_; }
    tuple<Tail...>& __tail() noexcept { return tail_; }
    const tuple<Tail...>& __tail() const noexcept { return tail_; }

    void swap(tuple& other) {
        std::swap(head_, other.head_);
        tail_.swap(other.tail_);
    }

private:
    Head head_;
    tuple<Tail...> tail_;
};

template <typename T>
struct tuple_size;

template <typename... Ts>
struct tuple_size<tuple<Ts...>> : integral_constant<size_t, sizeof...(Ts)> {};

template <typename T>
struct tuple_size<const T> : tuple_size<T> {};

template <typename T>
inline constexpr size_t tuple_size_v = tuple_size<T>::value;

template <size_t I, typename T>
struct tuple_element;

template <typename Head, typename... Tail>
struct tuple_element<0, tuple<Head, Tail...>> {
    using type = Head;
};

template <size_t I, typename Head, typename... Tail>
struct tuple_element<I, tuple<Head, Tail...>> : tuple_element<I - 1, tuple<Tail...>> {};

template <size_t I, typename T>
struct tuple_element<I, const T> {
    using type = const typename tuple_element<I, T>::type;
};

template <size_t I, typename T>
using tuple_element_t = typename tuple_element<I, T>::type;

namespace __console {

template <size_t I>
struct tuple_get {
    template <typename Group>
    static auto& at(Group& group) {
        return tuple_get<I - 1>::at(group.__tail());
    }
};

template <>
struct tuple_get<0> {
    template <typename Group>
    static auto& at(Group& group) {
        return group.__head();
    }
};

}  // namespace __console

template <size_t I, typename... Ts>
inline tuple_element_t<I, tuple<Ts...>>& get(tuple<Ts...>& group) noexcept {
    return __console::tuple_get<I>::at(group);
}

template <size_t I, typename... Ts>
inline const tuple_element_t<I, tuple<Ts...>>& get(const tuple<Ts...>& group) noexcept {
    return __console::tuple_get<I>::at(group);
}

template <size_t I, typename... Ts>
inline tuple_element_t<I, tuple<Ts...>>&& get(tuple<Ts...>&& group) noexcept {
    return move(__console::tuple_get<I>::at(group));
}

template <typename... Ts>
inline tuple<decay_t<Ts>...> make_tuple(Ts&&... values) {
    return tuple<decay_t<Ts>...>(forward<Ts>(values)...);
}

template <typename... Ts>
inline tuple<Ts&...> tie(Ts&... targets) noexcept {
    return tuple<Ts&...>(targets...);
}

template <typename... Ts>
inline tuple<Ts&&...> forward_as_tuple(Ts&&... values) noexcept {
    return tuple<Ts&&...>(forward<Ts>(values)...);
}

// Named on the left of a tie() for a member of the group that is not wanted.
namespace __console {

struct ignore_t {
    template <typename T>
    const ignore_t& operator=(const T&) const noexcept {
        return *this;
    }
};

}  // namespace __console

inline constexpr __console::ignore_t ignore{};

inline bool operator==(const tuple<>&, const tuple<>&) noexcept { return true; }

// Down the same recursion the group is built out of, which stops at the first
// pair that differs rather than comparing every element regardless.
template <typename Head, typename... Tail, typename UHead, typename... UTail>
inline bool operator==(const tuple<Head, Tail...>& left, const tuple<UHead, UTail...>& right) {
    static_assert(sizeof...(Tail) == sizeof...(UTail),
                  "tuples of different lengths are not comparable");
    return left.__head() == right.__head() && left.__tail() == right.__tail();
}

template <typename... Ts, typename... Us>
inline bool operator!=(const tuple<Ts...>& left, const tuple<Us...>& right) {
    return !(left == right);
}

template <typename... Ts>
inline void swap(tuple<Ts...>& left, tuple<Ts...>& right) {
    left.swap(right);
}

}  // namespace std

#endif
