// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// The algorithms over a pair of iterators. The containers here hand out plain
// pointers, so nothing needs iterator_traits to work out what a range holds.

#ifndef CONSOLE_CXX_ALGORITHM
#define CONSOLE_CXX_ALGORITHM

#include <stddef.h>

#include <type_traits>
#include <utility>

namespace std {

template <typename T>
constexpr const T& min(const T& left, const T& right) {
    return right < left ? right : left;
}

template <typename T, typename Compare>
constexpr const T& min(const T& left, const T& right, Compare before) {
    return before(right, left) ? right : left;
}

template <typename T>
constexpr const T& max(const T& left, const T& right) {
    return left < right ? right : left;
}

template <typename T, typename Compare>
constexpr const T& max(const T& left, const T& right, Compare before) {
    return before(left, right) ? right : left;
}

template <typename T>
constexpr const T& clamp(const T& value, const T& low, const T& high) {
    return value < low ? low : (high < value ? high : value);
}

template <typename Iterator>
inline void iter_swap(Iterator left, Iterator right) {
    swap(*left, *right);
}

template <typename Iterator, typename Predicate>
inline bool all_of(Iterator first, Iterator last, Predicate holds) {
    for (; first != last; ++first)
        if (!holds(*first)) return false;
    return true;
}

template <typename Iterator, typename Predicate>
inline bool any_of(Iterator first, Iterator last, Predicate holds) {
    for (; first != last; ++first)
        if (holds(*first)) return true;
    return false;
}

template <typename Iterator, typename Predicate>
inline bool none_of(Iterator first, Iterator last, Predicate holds) {
    return !any_of(first, last, holds);
}

template <typename Iterator, typename T>
inline Iterator find(Iterator first, Iterator last, const T& value) {
    for (; first != last; ++first)
        if (*first == value) return first;
    return last;
}

template <typename Iterator, typename Predicate>
inline Iterator find_if(Iterator first, Iterator last, Predicate holds) {
    for (; first != last; ++first)
        if (holds(*first)) return first;
    return last;
}

template <typename Iterator, typename T>
inline size_t count(Iterator first, Iterator last, const T& value) {
    size_t found = 0;
    for (; first != last; ++first)
        if (*first == value) ++found;
    return found;
}

template <typename Iterator, typename Predicate>
inline size_t count_if(Iterator first, Iterator last, Predicate holds) {
    size_t found = 0;
    for (; first != last; ++first)
        if (holds(*first)) ++found;
    return found;
}

template <typename Iterator, typename Function>
inline Function for_each(Iterator first, Iterator last, Function visit) {
    for (; first != last; ++first) visit(*first);
    return visit;
}

template <typename Iterator, typename Output>
inline Output copy(Iterator first, Iterator last, Output to) {
    for (; first != last; ++first, ++to) *to = *first;
    return to;
}

template <typename Iterator, typename Output>
inline Output copy_backward(Iterator first, Iterator last, Output end) {
    while (first != last) *--end = *--last;
    return end;
}

template <typename Iterator, typename Output>
inline Output move(Iterator first, Iterator last, Output to) {
    for (; first != last; ++first, ++to) *to = std::move(*first);
    return to;
}

template <typename Iterator, typename T>
inline void fill(Iterator first, Iterator last, const T& value) {
    for (; first != last; ++first) *first = value;
}

template <typename Left, typename Right>
inline bool equal(Left first, Left last, Right other) {
    for (; first != last; ++first, ++other)
        if (!(*first == *other)) return false;
    return true;
}

template <typename Left, typename Right>
inline bool lexicographical_compare(Left first, Left last, Right other_first, Right other_last) {
    for (; first != last && other_first != other_last; ++first, ++other_first) {
        if (*first < *other_first) return true;
        if (*other_first < *first) return false;
    }
    return first == last && other_first != other_last;
}

template <typename Iterator>
inline void reverse(Iterator first, Iterator last) {
    while (first != last && first != --last) iter_swap(first++, last);
}

template <typename Iterator>
inline Iterator min_element(Iterator first, Iterator last) {
    if (first == last) return last;
    Iterator smallest = first;
    for (++first; first != last; ++first)
        if (*first < *smallest) smallest = first;
    return smallest;
}

template <typename Iterator>
inline Iterator max_element(Iterator first, Iterator last) {
    if (first == last) return last;
    Iterator largest = first;
    for (++first; first != last; ++first)
        if (*largest < *first) largest = first;
    return largest;
}

template <typename Iterator, typename T, typename Compare>
inline Iterator lower_bound(Iterator first, Iterator last, const T& value, Compare before) {
    size_t count = static_cast<size_t>(last - first);
    while (count) {
        size_t half = count / 2;
        Iterator middle = first + half;
        if (before(*middle, value)) {
            first = middle + 1;
            count -= half + 1;
        } else {
            count = half;
        }
    }
    return first;
}

template <typename Iterator, typename T>
inline Iterator lower_bound(Iterator first, Iterator last, const T& value) {
    return lower_bound(first, last, value,
                       [](const T& left, const T& right) { return left < right; });
}

template <typename Iterator, typename T, typename Compare>
inline Iterator upper_bound(Iterator first, Iterator last, const T& value, Compare before) {
    size_t count = static_cast<size_t>(last - first);
    while (count) {
        size_t half = count / 2;
        Iterator middle = first + half;
        if (before(value, *middle)) {
            count = half;
        } else {
            first = middle + 1;
            count -= half + 1;
        }
    }
    return first;
}

template <typename Iterator, typename T>
inline Iterator upper_bound(Iterator first, Iterator last, const T& value) {
    return upper_bound(first, last, value,
                       [](const T& left, const T& right) { return left < right; });
}

template <typename Iterator, typename T>
inline bool binary_search(Iterator first, Iterator last, const T& value) {
    Iterator at = lower_bound(first, last, value);
    return at != last && !(value < *at);
}

namespace __console {

// A run this short is faster to sort by moving each element back into place
// than by partitioning it again.
constexpr ptrdiff_t sort_threshold = 16;

template <typename Iterator, typename Compare>
void insertion_sort(Iterator first, Iterator last, Compare before) {
    for (Iterator at = first + 1; at < last; ++at) {
        auto held = std::move(*at);
        Iterator hole = at;
        while (hole > first && before(held, *(hole - 1))) {
            *hole = std::move(*(hole - 1));
            --hole;
        }
        *hole = std::move(held);
    }
}

template <typename Iterator, typename Compare>
void sift_down(Iterator first, ptrdiff_t root, ptrdiff_t count, Compare before) {
    while (true) {
        ptrdiff_t largest = root;
        ptrdiff_t left = 2 * root + 1;
        ptrdiff_t right = left + 1;
        if (left < count && before(first[largest], first[left])) largest = left;
        if (right < count && before(first[largest], first[right])) largest = right;
        if (largest == root) return;
        iter_swap(first + root, first + largest);
        root = largest;
    }
}

// The fallback when partitioning keeps going badly: heapsort is no faster on
// an ordinary range but it cannot be driven quadratic by one.
template <typename Iterator, typename Compare>
void heap_sort(Iterator first, Iterator last, Compare before) {
    ptrdiff_t count = last - first;
    for (ptrdiff_t root = count / 2; root-- > 0;) sift_down(first, root, count, before);
    for (ptrdiff_t end = count; end-- > 1;) {
        iter_swap(first, first + end);
        sift_down(first, 0, end, before);
    }
}

template <typename Iterator, typename Compare>
void introsort(Iterator first, Iterator last, ptrdiff_t depth, Compare before) {
    while (last - first > sort_threshold) {
        if (depth == 0) {
            heap_sort(first, last, before);
            return;
        }
        --depth;

        // Median of the two ends and the middle, parked at the front so the
        // partition below never runs off either end of the range.
        Iterator middle = first + (last - first) / 2;
        Iterator back = last - 1;
        if (before(*middle, *first)) iter_swap(middle, first);
        if (before(*back, *middle)) {
            iter_swap(back, middle);
            if (before(*middle, *first)) iter_swap(middle, first);
        }
        iter_swap(first, middle);

        Iterator low = first;
        Iterator high = last;
        while (true) {
            while (before(*++low, *first))
                ;
            while (before(*first, *--high))
                ;
            if (low >= high) break;
            iter_swap(low, high);
        }
        iter_swap(first, high);

        // The larger half goes back on the loop and the smaller one recurses,
        // which keeps the recursion logarithmic however the range is shaped.
        if (high - first < last - (high + 1)) {
            introsort(first, high, depth, before);
            first = high + 1;
        } else {
            introsort(high + 1, last, depth, before);
            last = high;
        }
    }
    if (last - first > 1) insertion_sort(first, last, before);
}

}  // namespace __console

template <typename Iterator, typename Compare>
inline void sort(Iterator first, Iterator last, Compare before) {
    ptrdiff_t count = last - first;
    if (count < 2) return;
    // Twice the depth a balanced split would need, which is where a range
    // stops looking like bad luck and starts looking adversarial.
    ptrdiff_t depth = 0;
    for (ptrdiff_t span = count; span > 1; span /= 2) depth += 2;
    __console::introsort(first, last, depth, before);
}

template <typename Iterator>
inline void sort(Iterator first, Iterator last) {
    sort(first, last, [](const auto& left, const auto& right) { return left < right; });
}

}  // namespace std

#endif
