// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// A borrowed run of characters, the traits that say what a character is, and
// the hash every keyed container reaches for. std::hash lives here because
// this is the header that first needs it, which is where <string> and
// <unordered_set> already look for it.

#ifndef CONSOLE_CXX_STRING_VIEW
#define CONSOLE_CXX_STRING_VIEW

#include <stddef.h>
#include <stdint.h>

#include <cwchar>
#include <type_traits>

namespace std {

template <typename Char>
struct char_traits;

template <>
struct char_traits<char> {
    using char_type = char;
    using int_type = int;

    static void assign(char& target, const char& value) noexcept { target = value; }
    static constexpr bool eq(char left, char right) noexcept { return left == right; }
    static constexpr bool lt(char left, char right) noexcept {
        return static_cast<unsigned char>(left) < static_cast<unsigned char>(right);
    }

    static constexpr size_t length(const char* text) noexcept { return __builtin_strlen(text); }

    static constexpr int compare(const char* left, const char* right, size_t count) noexcept {
        return count ? __builtin_memcmp(left, right, count) : 0;
    }

    static constexpr const char* find(const char* text, size_t count, const char& value) noexcept {
        return count ? static_cast<const char*>(__builtin_memchr(text, value, count)) : nullptr;
    }

    static char* move(char* to, const char* from, size_t count) noexcept {
        return count ? static_cast<char*>(__builtin_memmove(to, from, count)) : to;
    }

    static char* copy(char* to, const char* from, size_t count) noexcept {
        return count ? static_cast<char*>(__builtin_memcpy(to, from, count)) : to;
    }

    static char* assign(char* to, size_t count, char value) noexcept {
        return count ? static_cast<char*>(__builtin_memset(to, value, count)) : to;
    }

    static constexpr int_type eof() noexcept { return -1; }
    static constexpr int_type not_eof(int_type value) noexcept {
        return value == eof() ? 0 : value;
    }
    static constexpr char to_char_type(int_type value) noexcept {
        return static_cast<char>(value);
    }
    static constexpr int_type to_int_type(char value) noexcept {
        return static_cast<unsigned char>(value);
    }
    static constexpr bool eq_int_type(int_type left, int_type right) noexcept {
        return left == right;
    }
};

// The console has no wide character support: these name the routines
// <cwchar> declares and nothing defines, so a guest that instantiates them
// fails to link rather than silently getting a narrow answer.
template <>
struct char_traits<wchar_t> {
    using char_type = wchar_t;
    using int_type = wint_t;

    static void assign(wchar_t& target, const wchar_t& value) noexcept { target = value; }
    static constexpr bool eq(wchar_t left, wchar_t right) noexcept { return left == right; }
    static constexpr bool lt(wchar_t left, wchar_t right) noexcept { return left < right; }

    static size_t length(const wchar_t* text) noexcept { return ::wcslen(text); }
    static int compare(const wchar_t* left, const wchar_t* right, size_t count) noexcept {
        return ::wmemcmp(left, right, count);
    }
    static const wchar_t* find(const wchar_t* text, size_t count, const wchar_t& value) noexcept {
        return ::wmemchr(text, value, count);
    }
    static wchar_t* move(wchar_t* to, const wchar_t* from, size_t count) noexcept {
        return ::wmemmove(to, from, count);
    }
    static wchar_t* copy(wchar_t* to, const wchar_t* from, size_t count) noexcept {
        return ::wmemcpy(to, from, count);
    }
    static wchar_t* assign(wchar_t* to, size_t count, wchar_t value) noexcept {
        return ::wmemset(to, value, count);
    }

    static constexpr int_type eof() noexcept { return WEOF; }
    static constexpr int_type not_eof(int_type value) noexcept {
        return value == eof() ? 0 : value;
    }
    static constexpr wchar_t to_char_type(int_type value) noexcept {
        return static_cast<wchar_t>(value);
    }
    static constexpr int_type to_int_type(wchar_t value) noexcept {
        return static_cast<int_type>(value);
    }
    static constexpr bool eq_int_type(int_type left, int_type right) noexcept {
        return left == right;
    }
};

template <typename Char, typename Traits = char_traits<Char>>
class basic_string_view {
public:
    using traits_type = Traits;
    using value_type = Char;
    using size_type = size_t;
    using difference_type = ptrdiff_t;
    using const_reference = const Char&;
    using reference = const Char&;
    using const_pointer = const Char*;
    using pointer = const Char*;
    using const_iterator = const Char*;
    using iterator = const Char*;

    static constexpr size_type npos = static_cast<size_type>(-1);

    constexpr basic_string_view() noexcept : first_(nullptr), size_(0) {}
    constexpr basic_string_view(const Char* text, size_type count) noexcept
        : first_(text), size_(count) {}
    constexpr basic_string_view(const Char* text) noexcept
        : first_(text), size_(text ? Traits::length(text) : 0) {}

    constexpr size_type size() const noexcept { return size_; }
    constexpr size_type length() const noexcept { return size_; }
    constexpr bool empty() const noexcept { return size_ == 0; }
    constexpr const Char* data() const noexcept { return first_; }

    constexpr const_iterator begin() const noexcept { return first_; }
    constexpr const_iterator end() const noexcept { return first_ + size_; }
    constexpr const_iterator cbegin() const noexcept { return begin(); }
    constexpr const_iterator cend() const noexcept { return end(); }

    constexpr const Char& operator[](size_type index) const { return first_[index]; }
    constexpr const Char& front() const { return first_[0]; }
    constexpr const Char& back() const { return first_[size_ - 1]; }

    constexpr void remove_prefix(size_type count) noexcept {
        first_ += count;
        size_ -= count;
    }

    constexpr void remove_suffix(size_type count) noexcept { size_ -= count; }

    constexpr basic_string_view substr(size_type from = 0, size_type count = npos) const {
        size_type left = from < size_ ? size_ - from : 0;
        return basic_string_view(first_ + from, count < left ? count : left);
    }

    constexpr int compare(basic_string_view other) const noexcept {
        size_type shared = size_ < other.size_ ? size_ : other.size_;
        int order = Traits::compare(first_, other.first_, shared);
        if (order) return order;
        return size_ == other.size_ ? 0 : (size_ < other.size_ ? -1 : 1);
    }

    constexpr size_type find(Char value, size_type from = 0) const noexcept {
        for (size_type i = from; i < size_; ++i)
            if (Traits::eq(first_[i], value)) return i;
        return npos;
    }

    constexpr size_type find(basic_string_view needle, size_type from = 0) const noexcept {
        if (needle.size_ > size_) return npos;
        for (size_type i = from; i + needle.size_ <= size_; ++i)
            if (Traits::compare(first_ + i, needle.first_, needle.size_) == 0) return i;
        return npos;
    }

private:
    const Char* first_;
    size_type size_;
};

template <typename Char, typename Traits>
constexpr bool operator==(basic_string_view<Char, Traits> left,
                          basic_string_view<Char, Traits> right) noexcept {
    return left.size() == right.size() && left.compare(right) == 0;
}

// A view is compared against a literal often enough that the conversions the
// standard leaves to overload resolution are spelled out here instead.
template <typename Char, typename Traits>
constexpr bool operator==(basic_string_view<Char, Traits> left, const Char* right) noexcept {
    return left == basic_string_view<Char, Traits>(right);
}

template <typename Char, typename Traits>
constexpr bool operator==(const Char* left, basic_string_view<Char, Traits> right) noexcept {
    return basic_string_view<Char, Traits>(left) == right;
}

template <typename Char, typename Traits>
constexpr bool operator!=(basic_string_view<Char, Traits> left,
                          basic_string_view<Char, Traits> right) noexcept {
    return !(left == right);
}

template <typename Char, typename Traits>
constexpr bool operator!=(basic_string_view<Char, Traits> left, const Char* right) noexcept {
    return !(left == right);
}

template <typename Char, typename Traits>
constexpr bool operator!=(const Char* left, basic_string_view<Char, Traits> right) noexcept {
    return !(left == right);
}

template <typename Char, typename Traits>
constexpr bool operator<(basic_string_view<Char, Traits> left,
                         basic_string_view<Char, Traits> right) noexcept {
    return left.compare(right) < 0;
}

template <typename Char, typename Traits>
constexpr bool operator>(basic_string_view<Char, Traits> left,
                         basic_string_view<Char, Traits> right) noexcept {
    return right < left;
}

template <typename Char, typename Traits>
constexpr bool operator<=(basic_string_view<Char, Traits> left,
                          basic_string_view<Char, Traits> right) noexcept {
    return !(right < left);
}

template <typename Char, typename Traits>
constexpr bool operator>=(basic_string_view<Char, Traits> left,
                          basic_string_view<Char, Traits> right) noexcept {
    return !(left < right);
}

using string_view = basic_string_view<char>;
using wstring_view = basic_string_view<wchar_t>;

namespace __console {

// Defined in src/support.cpp. Any function of the bytes will do: nothing
// outside one run ever sees these values.
size_t hash_bytes(const void* bytes, size_t length) noexcept;

}  // namespace __console

// The default hash of a key. Anything that fits in a word hashes to its own
// bits scrambled; everything else has to say how, which is what specialising
// this is for.
template <typename T>
struct hash;

#define CONSOLE_SCALAR_HASH(type)                                       \
    template <>                                                         \
    struct hash<type> {                                                 \
        size_t operator()(type value) const noexcept {                  \
            return __console::hash_bytes(&value, sizeof(value));        \
        }                                                               \
    }

CONSOLE_SCALAR_HASH(bool);
CONSOLE_SCALAR_HASH(char);
CONSOLE_SCALAR_HASH(signed char);
CONSOLE_SCALAR_HASH(unsigned char);
CONSOLE_SCALAR_HASH(wchar_t);
CONSOLE_SCALAR_HASH(char16_t);
CONSOLE_SCALAR_HASH(char32_t);
CONSOLE_SCALAR_HASH(short);
CONSOLE_SCALAR_HASH(unsigned short);
CONSOLE_SCALAR_HASH(int);
CONSOLE_SCALAR_HASH(unsigned int);
CONSOLE_SCALAR_HASH(long);
CONSOLE_SCALAR_HASH(unsigned long);
CONSOLE_SCALAR_HASH(long long);
CONSOLE_SCALAR_HASH(unsigned long long);

#undef CONSOLE_SCALAR_HASH

// A float is hashed by its bytes like everything else, except that the two
// spellings of zero have to land on the same value because they compare equal.
#define CONSOLE_FLOAT_HASH(type)                                        \
    template <>                                                         \
    struct hash<type> {                                                 \
        size_t operator()(type value) const noexcept {                  \
            if (value == 0) return 0;                                   \
            return __console::hash_bytes(&value, sizeof(value));        \
        }                                                               \
    }

CONSOLE_FLOAT_HASH(float);
CONSOLE_FLOAT_HASH(double);
CONSOLE_FLOAT_HASH(long double);

#undef CONSOLE_FLOAT_HASH

template <typename T>
struct hash<T*> {
    size_t operator()(T* value) const noexcept {
        return __console::hash_bytes(&value, sizeof(value));
    }
};

template <typename Char, typename Traits>
struct hash<basic_string_view<Char, Traits>> {
    size_t operator()(basic_string_view<Char, Traits> view) const noexcept {
        return __console::hash_bytes(view.data(), view.size() * sizeof(Char));
    }
};

}  // namespace std

#endif
