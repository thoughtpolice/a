// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

#ifndef CONSOLE_CXX_VECTOR
#define CONSOLE_CXX_VECTOR

#include <__cxx_support>

namespace std {

// Iterators are plain pointers, so the compiler's own <algorithm> and
// iterator_traits accept them without any further declarations here.
template <typename T>
class vector {
public:
    using value_type = T;
    using size_type = size_t;
    using difference_type = ptrdiff_t;
    using reference = T&;
    using const_reference = const T&;
    using pointer = T*;
    using const_pointer = const T*;
    using iterator = T*;
    using const_iterator = const T*;

    vector() = default;

    explicit vector(size_type count) {
        reserve(count);
        for (size_type i = 0; i < count; ++i) ::new (static_cast<void*>(first_ + i)) T();
        last_ = first_ + count;
    }

    vector(size_type count, const T& value) { assign(count, value); }

    template <typename Iterator, typename = decltype(*declval<Iterator&>())>
    vector(Iterator from, Iterator to) {
        for (; from != to; ++from) push_back(*from);
    }

    vector(initializer_list<T> values) {
        reserve(values.size());
        for (const T& value : values) ::new (static_cast<void*>(last_++)) T(value);
    }

    vector(const vector& other) {
        reserve(other.size());
        for (const T& value : other) ::new (static_cast<void*>(last_++)) T(value);
    }

    vector(vector&& other) noexcept
        : first_(other.first_), last_(other.last_), end_(other.end_) {
        other.first_ = other.last_ = other.end_ = nullptr;
    }

    ~vector() {
        __console::destroy(first_, last_);
        __console::deallocate(first_);
    }

    vector& operator=(const vector& other) {
        if (this != &other) {
            clear();
            reserve(other.size());
            for (const T& value : other) ::new (static_cast<void*>(last_++)) T(value);
        }
        return *this;
    }

    vector& operator=(vector&& other) noexcept {
        if (this != &other) {
            __console::destroy(first_, last_);
            __console::deallocate(first_);
            first_ = other.first_;
            last_ = other.last_;
            end_ = other.end_;
            other.first_ = other.last_ = other.end_ = nullptr;
        }
        return *this;
    }

    vector& operator=(initializer_list<T> values) {
        clear();
        reserve(values.size());
        for (const T& value : values) ::new (static_cast<void*>(last_++)) T(value);
        return *this;
    }

    void assign(size_type count, const T& value) {
        clear();
        reserve(count);
        for (size_type i = 0; i < count; ++i) ::new (static_cast<void*>(last_++)) T(value);
    }

    template <typename Iterator, typename = decltype(*declval<Iterator&>())>
    void assign(Iterator from, Iterator to) {
        clear();
        for (; from != to; ++from) push_back(*from);
    }

    size_type size() const noexcept { return static_cast<size_type>(last_ - first_); }
    size_type capacity() const noexcept { return static_cast<size_type>(end_ - first_); }
    bool empty() const noexcept { return first_ == last_; }

    T* data() noexcept { return first_; }
    const T* data() const noexcept { return first_; }
    iterator begin() noexcept { return first_; }
    iterator end() noexcept { return last_; }
    const_iterator begin() const noexcept { return first_; }
    const_iterator end() const noexcept { return last_; }
    const_iterator cbegin() const noexcept { return first_; }
    const_iterator cend() const noexcept { return last_; }

    reference operator[](size_type index) { return first_[index]; }
    const_reference operator[](size_type index) const { return first_[index]; }
    reference at(size_type index) {
        if (index >= size()) __console_cxx_fail("vector index out of range");
        return first_[index];
    }
    const_reference at(size_type index) const {
        if (index >= size()) __console_cxx_fail("vector index out of range");
        return first_[index];
    }
    reference front() { return *first_; }
    const_reference front() const { return *first_; }
    reference back() { return last_[-1]; }
    const_reference back() const { return last_[-1]; }

    void reserve(size_type least) {
        if (least <= capacity()) return;
        T* moved = static_cast<T*>(__console::allocate(least * sizeof(T)));
        size_type count = size();
        __console::relocate(moved, first_, last_);
        __console::deallocate(first_);
        first_ = moved;
        last_ = moved + count;
        end_ = moved + least;
    }

    void resize(size_type count) {
        if (count < size()) {
            __console::destroy(first_ + count, last_);
        } else if (count > size()) {
            reserve(count);
            for (T* at = last_; at != first_ + count; ++at) ::new (static_cast<void*>(at)) T();
        }
        last_ = first_ + count;
    }

    void resize(size_type count, const T& value) {
        if (count < size()) {
            __console::destroy(first_ + count, last_);
        } else if (count > size()) {
            reserve(count);
            for (T* at = last_; at != first_ + count; ++at) ::new (static_cast<void*>(at)) T(value);
        }
        last_ = first_ + count;
    }

    void push_back(const T& value) { emplace_back(value); }
    void push_back(T&& value) { emplace_back(move(value)); }

    template <typename... Args>
    reference emplace_back(Args&&... args) {
        if (last_ == end_) reserve(__console::grow(capacity(), size() + 1));
        ::new (static_cast<void*>(last_)) T(forward<Args>(args)...);
        return *last_++;
    }

    void pop_back() { (--last_)->~T(); }

    void clear() noexcept {
        __console::destroy(first_, last_);
        last_ = first_;
    }

    iterator insert(const_iterator where, const T& value) { return emplace(where, value); }
    iterator insert(const_iterator where, T&& value) { return emplace(where, move(value)); }

    template <typename Iterator, typename = decltype(*declval<Iterator&>())>
    iterator insert(const_iterator where, Iterator from, Iterator to) {
        size_type at = static_cast<size_type>(where - first_);
        size_type added = 0;
        for (Iterator scan = from; scan != to; ++scan) ++added;
        if (added == 0) return first_ + at;
        reserve(size() + added);
        T* hole = first_ + at;
        // Opened from the back so the surviving elements move once each.
        for (T* source = last_; source != hole;) {
            --source;
            ::new (static_cast<void*>(source + added)) T(move(*source));
            source->~T();
        }
        for (; from != to; ++from, ++hole) ::new (static_cast<void*>(hole)) T(*from);
        last_ += added;
        return first_ + at;
    }

    template <typename... Args>
    iterator emplace(const_iterator where, Args&&... args) {
        size_type at = static_cast<size_type>(where - first_);
        if (last_ == end_) reserve(__console::grow(capacity(), size() + 1));
        T* hole = first_ + at;
        for (T* source = last_; source != hole;) {
            --source;
            ::new (static_cast<void*>(source + 1)) T(move(*source));
            source->~T();
        }
        ::new (static_cast<void*>(hole)) T(forward<Args>(args)...);
        ++last_;
        return hole;
    }

    iterator erase(const_iterator where) { return erase(where, where + 1); }

    iterator erase(const_iterator from, const_iterator to) {
        T* head = first_ + (from - first_);
        T* tail = first_ + (to - first_);
        if (head == tail) return head;
        for (T* source = tail; source != last_; ++source, ++head) {
            head->~T();
            ::new (static_cast<void*>(head)) T(move(*source));
        }
        __console::destroy(head, last_);
        last_ = head;
        return first_ + (from - first_);
    }

    void swap(vector& other) noexcept {
        T* first = first_; first_ = other.first_; other.first_ = first;
        T* last = last_; last_ = other.last_; other.last_ = last;
        T* end = end_; end_ = other.end_; other.end_ = end;
    }

private:
    T* first_ = nullptr;
    T* last_ = nullptr;
    T* end_ = nullptr;
};

template <typename T>
inline bool operator==(const vector<T>& left, const vector<T>& right) {
    if (left.size() != right.size()) return false;
    for (size_t i = 0; i < left.size(); ++i)
        if (!(left[i] == right[i])) return false;
    return true;
}

template <typename T>
inline bool operator!=(const vector<T>& left, const vector<T>& right) {
    return !(left == right);
}

template <typename T>
inline void swap(vector<T>& left, vector<T>& right) noexcept {
    left.swap(right);
}

}  // namespace std

#endif
