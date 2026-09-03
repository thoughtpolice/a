// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

#ifndef CONSOLE_CXX_STRING
#define CONSOLE_CXX_STRING

#include <string.h>

#include <__cxx_support>
// char_traits, the hash the compiler's headers already specialise for views,
// and the view this string converts to.
#include <string_view>

namespace std {

class string {
public:
    using value_type = char;
    using size_type = size_t;
    using difference_type = ptrdiff_t;
    using reference = char&;
    using const_reference = const char&;
    using iterator = char*;
    using const_iterator = const char*;

    static constexpr size_type npos = static_cast<size_type>(-1);

    string() = default;
    string(const char* text) : string(text, text ? __builtin_strlen(text) : 0) {}

    string(const char* text, size_type count) {
        if (count) {
            reserve(count);
            __builtin_memcpy(data_, text, count);
            size_ = count;
            data_[size_] = '\0';
        }
    }

    string(size_type count, char fill) {
        if (count) {
            reserve(count);
            __builtin_memset(data_, fill, count);
            size_ = count;
            data_[size_] = '\0';
        }
    }

    explicit string(string_view view) : string(view.data(), view.size()) {}

    template <typename Iterator, typename = decltype(*declval<Iterator&>())>
    string(Iterator from, Iterator to) {
        for (; from != to; ++from) push_back(*from);
    }

    string(const string& other) : string(other.data_, other.size_) {}

    string(string&& other) noexcept
        : data_(other.data_), size_(other.size_), capacity_(other.capacity_) {
        other.data_ = nullptr;
        other.size_ = other.capacity_ = 0;
    }

    ~string() { __console::deallocate(data_); }

    string& operator=(const string& other) {
        if (this != &other) assign(other.data_, other.size_);
        return *this;
    }

    string& operator=(string&& other) noexcept {
        if (this != &other) {
            __console::deallocate(data_);
            data_ = other.data_;
            size_ = other.size_;
            capacity_ = other.capacity_;
            other.data_ = nullptr;
            other.size_ = other.capacity_ = 0;
        }
        return *this;
    }

    string& operator=(const char* text) { return assign(text, text ? __builtin_strlen(text) : 0); }

    string& assign(const char* text, size_type count) {
        clear();
        if (count) {
            reserve(count);
            __builtin_memmove(data_, text, count);
            size_ = count;
            data_[size_] = '\0';
        }
        return *this;
    }

    size_type size() const noexcept { return size_; }
    size_type length() const noexcept { return size_; }
    size_type capacity() const noexcept { return capacity_; }
    bool empty() const noexcept { return size_ == 0; }

    // Always NUL terminated, including before the first write, so a string
    // handed to the C library never needs a special case for the empty one.
    const char* c_str() const noexcept { return data_ ? data_ : ""; }
    const char* data() const noexcept { return c_str(); }
    char* data() noexcept { return data_ ? data_ : const_cast<char*>(""); }

    iterator begin() noexcept { return data(); }
    iterator end() noexcept { return data() + size_; }
    const_iterator begin() const noexcept { return data(); }
    const_iterator end() const noexcept { return data() + size_; }
    const_iterator cbegin() const noexcept { return begin(); }
    const_iterator cend() const noexcept { return end(); }

    reference operator[](size_type index) { return data()[index]; }
    const_reference operator[](size_type index) const { return data()[index]; }
    reference front() { return data()[0]; }
    const_reference front() const { return data()[0]; }
    reference back() { return data()[size_ - 1]; }
    const_reference back() const { return data()[size_ - 1]; }

    operator string_view() const noexcept { return string_view(c_str(), size_); }

    void reserve(size_type least) {
        if (least <= capacity_) return;
        size_type next = __console::grow(capacity_, least);
        char* moved = static_cast<char*>(__console::allocate(next + 1));
        if (size_) __builtin_memcpy(moved, data_, size_);
        moved[size_] = '\0';
        __console::deallocate(data_);
        data_ = moved;
        capacity_ = next;
    }

    void resize(size_type count, char fill = '\0') {
        if (count > size_) {
            reserve(count);
            __builtin_memset(data_ + size_, fill, count - size_);
        }
        size_ = count;
        if (data_) data_[size_] = '\0';
    }

    void clear() noexcept {
        size_ = 0;
        if (data_) data_[0] = '\0';
    }

    void push_back(char value) {
        reserve(size_ + 1);
        data_[size_++] = value;
        data_[size_] = '\0';
    }

    void pop_back() {
        --size_;
        data_[size_] = '\0';
    }

    string& append(const char* text, size_type count) {
        if (count) {
            reserve(size_ + count);
            __builtin_memmove(data_ + size_, text, count);
            size_ += count;
            data_[size_] = '\0';
        }
        return *this;
    }

    string& append(const char* text) { return append(text, __builtin_strlen(text)); }
    string& append(const string& other) { return append(other.c_str(), other.size_); }
    string& append(string_view view) { return append(view.data(), view.size()); }
    string& append(size_type count, char fill) {
        reserve(size_ + count);
        __builtin_memset(data_ + size_, fill, count);
        size_ += count;
        data_[size_] = '\0';
        return *this;
    }

    string& operator+=(const string& other) { return append(other); }
    string& operator+=(const char* text) { return append(text); }
    string& operator+=(string_view view) { return append(view); }
    string& operator+=(char value) {
        push_back(value);
        return *this;
    }

    string substr(size_type from = 0, size_type count = npos) const {
        if (from > size_) __console_cxx_fail("string substr out of range");
        size_type left = size_ - from;
        return string(c_str() + from, count < left ? count : left);
    }

    int compare(const string& other) const noexcept {
        size_type shared = size_ < other.size_ ? size_ : other.size_;
        int order = shared ? __builtin_memcmp(c_str(), other.c_str(), shared) : 0;
        if (order) return order;
        return size_ == other.size_ ? 0 : (size_ < other.size_ ? -1 : 1);
    }

    size_type find(char value, size_type from = 0) const noexcept {
        for (size_type i = from; i < size_; ++i)
            if (data_[i] == value) return i;
        return npos;
    }

    size_type find(const char* needle, size_type from = 0) const noexcept {
        size_type count = __builtin_strlen(needle);
        if (count > size_) return npos;
        for (size_type i = from; i + count <= size_; ++i)
            if (__builtin_memcmp(data_ + i, needle, count) == 0) return i;
        return npos;
    }

    size_type rfind(char value) const noexcept {
        for (size_type i = size_; i-- > 0;)
            if (data_[i] == value) return i;
        return npos;
    }

    void swap(string& other) noexcept {
        char* data = data_; data_ = other.data_; other.data_ = data;
        size_type size = size_; size_ = other.size_; other.size_ = size;
        size_type capacity = capacity_; capacity_ = other.capacity_; other.capacity_ = capacity;
    }

private:
    char* data_ = nullptr;
    size_type size_ = 0;
    size_type capacity_ = 0;
};

inline bool operator==(const string& left, const string& right) noexcept {
    return left.size() == right.size() &&
           __builtin_memcmp(left.c_str(), right.c_str(), left.size()) == 0;
}

inline bool operator==(const string& left, const char* right) noexcept {
    return __builtin_strcmp(left.c_str(), right) == 0;
}

inline bool operator==(const char* left, const string& right) noexcept { return right == left; }
inline bool operator!=(const string& left, const string& right) noexcept { return !(left == right); }
inline bool operator!=(const string& left, const char* right) noexcept { return !(left == right); }
inline bool operator!=(const char* left, const string& right) noexcept { return !(right == left); }
inline bool operator<(const string& left, const string& right) noexcept { return left.compare(right) < 0; }
inline bool operator>(const string& left, const string& right) noexcept { return left.compare(right) > 0; }
inline bool operator<=(const string& left, const string& right) noexcept { return left.compare(right) <= 0; }
inline bool operator>=(const string& left, const string& right) noexcept { return left.compare(right) >= 0; }

inline string operator+(const string& left, const string& right) {
    string joined(left);
    joined.append(right);
    return joined;
}

inline string operator+(const string& left, const char* right) {
    string joined(left);
    joined.append(right);
    return joined;
}

inline string operator+(const char* left, const string& right) {
    string joined(left);
    joined.append(right);
    return joined;
}

inline string operator+(const string& left, char right) {
    string joined(left);
    joined.push_back(right);
    return joined;
}

inline void swap(string& left, string& right) noexcept { left.swap(right); }

template <>
struct hash<string> {
    size_t operator()(const string& text) const noexcept {
        return hash<string_view>()(string_view(text.c_str(), text.size()));
    }
};

}  // namespace std

#endif
