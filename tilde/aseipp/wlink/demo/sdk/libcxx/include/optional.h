// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// A value that may not be there. Reading one that is not is a fatal error
// rather than a bad_optional_access, for the same reason the containers
// report an index out of range that way: there are no exceptions to unwind
// with unless the guest asked for them.

#ifndef CONSOLE_CXX_OPTIONAL
#define CONSOLE_CXX_OPTIONAL

#include <__cxx_support>

namespace std {

struct nullopt_t {
    // The tag takes an argument so that `optional<T> o = {}` cannot be read
    // as constructing the tag.
    enum class __construct { token };
    explicit constexpr nullopt_t(__construct) noexcept {}
};

inline constexpr nullopt_t nullopt{nullopt_t::__construct::token};

template <typename T>
class optional {
public:
    using value_type = T;

    constexpr optional() noexcept : empty_(), engaged_(false) {}
    constexpr optional(nullopt_t) noexcept : empty_(), engaged_(false) {}

    optional(const optional& other) : empty_(), engaged_(false) {
        if (other.engaged_) construct(other.value_);
    }

    optional(optional&& other) : empty_(), engaged_(false) {
        if (other.engaged_) construct(move(other.value_));
    }

    template <typename... Args>
    explicit optional(in_place_t, Args&&... args) : empty_(), engaged_(false) {
        construct(forward<Args>(args)...);
    }

    template <typename U = T, typename = enable_if_t<is_constructible_v<T, U&&> &&
                                                     !is_same_v<decay_t<U>, optional> &&
                                                     !is_same_v<decay_t<U>, in_place_t> &&
                                                     !is_same_v<decay_t<U>, nullopt_t>>>
    optional(U&& value) : empty_(), engaged_(false) {
        construct(forward<U>(value));
    }

    ~optional() { reset(); }

    optional& operator=(nullopt_t) noexcept {
        reset();
        return *this;
    }

    optional& operator=(const optional& other) {
        if (this == &other) return *this;
        if (!other.engaged_) {
            reset();
        } else if (engaged_) {
            value_ = other.value_;
        } else {
            construct(other.value_);
        }
        return *this;
    }

    optional& operator=(optional&& other) {
        if (this == &other) return *this;
        if (!other.engaged_) {
            reset();
        } else if (engaged_) {
            value_ = move(other.value_);
        } else {
            construct(move(other.value_));
        }
        return *this;
    }

    template <typename U = T, typename = enable_if_t<!is_same_v<decay_t<U>, optional>>>
    optional& operator=(U&& value) {
        if (engaged_) {
            value_ = forward<U>(value);
        } else {
            construct(forward<U>(value));
        }
        return *this;
    }

    constexpr bool has_value() const noexcept { return engaged_; }
    constexpr explicit operator bool() const noexcept { return engaged_; }

    T& operator*() & noexcept { return value_; }
    const T& operator*() const& noexcept { return value_; }
    T&& operator*() && noexcept { return move(value_); }

    T* operator->() noexcept { return &value_; }
    const T* operator->() const noexcept { return &value_; }

    T& value() & {
        if (!engaged_) __console_cxx_fail("optional has no value");
        return value_;
    }

    const T& value() const& {
        if (!engaged_) __console_cxx_fail("optional has no value");
        return value_;
    }

    template <typename U>
    T value_or(U&& fallback) const& {
        return engaged_ ? value_ : static_cast<T>(forward<U>(fallback));
    }

    template <typename... Args>
    T& emplace(Args&&... args) {
        reset();
        construct(forward<Args>(args)...);
        return value_;
    }

    void reset() noexcept {
        if (engaged_) {
            value_.~T();
            engaged_ = false;
        }
    }

    void swap(optional& other) {
        if (engaged_ && other.engaged_) {
            std::swap(value_, other.value_);
        } else if (engaged_) {
            other.construct(move(value_));
            reset();
        } else if (other.engaged_) {
            construct(move(other.value_));
            other.reset();
        }
    }

private:
    template <typename... Args>
    void construct(Args&&... args) {
        ::new (static_cast<void*>(&value_)) T(forward<Args>(args)...);
        engaged_ = true;
    }

    // A union so that nothing is constructed until there is something to
    // hold, and so that the held object is a real T rather than bytes cast
    // to one.
    union {
        char empty_;
        T value_;
    };
    bool engaged_;
};

template <typename T>
inline bool operator==(const optional<T>& left, const optional<T>& right) {
    if (left.has_value() != right.has_value()) return false;
    return !left.has_value() || *left == *right;
}

template <typename T>
inline bool operator!=(const optional<T>& left, const optional<T>& right) {
    return !(left == right);
}

template <typename T>
inline bool operator==(const optional<T>& left, nullopt_t) noexcept {
    return !left.has_value();
}

template <typename T>
inline bool operator==(nullopt_t, const optional<T>& right) noexcept {
    return !right.has_value();
}

template <typename T>
inline bool operator!=(const optional<T>& left, nullopt_t) noexcept {
    return left.has_value();
}

template <typename T>
inline bool operator!=(nullopt_t, const optional<T>& right) noexcept {
    return right.has_value();
}

template <typename T>
constexpr optional<decay_t<T>> make_optional(T&& value) {
    return optional<decay_t<T>>(forward<T>(value));
}

template <typename T>
inline void swap(optional<T>& left, optional<T>& right) {
    left.swap(right);
}

}  // namespace std

#endif
