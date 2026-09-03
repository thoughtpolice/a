// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

#ifndef CONSOLE_CXX_UNORDERED_SET
#define CONSOLE_CXX_UNORDERED_SET

#include <__cxx_support>
// std::hash, which the compiler's own headers define for the builtin types
// and for string views.
#include <string_view>

namespace std {

// Open addressing with linear probing over a power-of-two table. Erasure
// marks a slot as a tombstone so the probe sequences over it stay intact.
template <typename Key, typename Hash = hash<Key>>
class unordered_set {
    enum State : unsigned char { empty_slot, used_slot, dead_slot };

public:
    using key_type = Key;
    using value_type = Key;
    using size_type = size_t;

    class const_iterator {
    public:
        const_iterator(const unordered_set* owner, size_type at) : owner_(owner), at_(at) {}

        const Key& operator*() const { return owner_->keys_[at_]; }
        const Key* operator->() const { return &owner_->keys_[at_]; }

        const_iterator& operator++() {
            ++at_;
            while (at_ < owner_->capacity_ && owner_->states_[at_] != used_slot) ++at_;
            return *this;
        }

        bool operator==(const const_iterator& other) const { return at_ == other.at_; }
        bool operator!=(const const_iterator& other) const { return at_ != other.at_; }

    private:
        const unordered_set* owner_;
        size_type at_;
    };

    using iterator = const_iterator;

    unordered_set() = default;

    unordered_set(initializer_list<Key> values) {
        for (const Key& value : values) insert(value);
    }

    unordered_set(const unordered_set& other) {
        for (const Key& value : other) insert(value);
    }

    unordered_set(unordered_set&& other) noexcept
        : keys_(other.keys_), states_(other.states_), capacity_(other.capacity_), size_(other.size_) {
        other.keys_ = nullptr;
        other.states_ = nullptr;
        other.capacity_ = other.size_ = 0;
    }

    ~unordered_set() { release(); }

    unordered_set& operator=(const unordered_set& other) {
        if (this != &other) {
            release();
            for (const Key& value : other) insert(value);
        }
        return *this;
    }

    unordered_set& operator=(unordered_set&& other) noexcept {
        if (this != &other) {
            release();
            keys_ = other.keys_;
            states_ = other.states_;
            capacity_ = other.capacity_;
            size_ = other.size_;
            other.keys_ = nullptr;
            other.states_ = nullptr;
            other.capacity_ = other.size_ = 0;
        }
        return *this;
    }

    size_type size() const noexcept { return size_; }
    bool empty() const noexcept { return size_ == 0; }

    const_iterator begin() const {
        size_type at = 0;
        while (at < capacity_ && states_[at] != used_slot) ++at;
        return const_iterator(this, at);
    }

    const_iterator end() const { return const_iterator(this, capacity_); }

    const_iterator find(const Key& key) const {
        if (!capacity_) return end();
        size_type mask = capacity_ - 1;
        for (size_type at = Hash()(key) & mask;; at = (at + 1) & mask) {
            if (states_[at] == empty_slot) return end();
            if (states_[at] == used_slot && keys_[at] == key) return const_iterator(this, at);
        }
    }

    size_type count(const Key& key) const { return find(key) == end() ? 0 : 1; }

    pair<const_iterator, bool> insert(const Key& key) {
        // Kept under three quarters full so the probe runs stay short.
        if ((size_ + 1) * 4 >= capacity_ * 3) rehash(capacity_ ? capacity_ * 2 : 16);
        size_type mask = capacity_ - 1;
        size_type hole = capacity_;
        for (size_type at = Hash()(key) & mask;; at = (at + 1) & mask) {
            if (states_[at] == used_slot) {
                if (keys_[at] == key) return {const_iterator(this, at), false};
            } else {
                if (states_[at] == dead_slot) {
                    if (hole == capacity_) hole = at;
                } else {
                    if (hole == capacity_) hole = at;
                    ::new (static_cast<void*>(&keys_[hole])) Key(key);
                    states_[hole] = used_slot;
                    ++size_;
                    return {const_iterator(this, hole), true};
                }
            }
        }
    }

    size_type erase(const Key& key) {
        const_iterator found = find(key);
        if (found == end()) return 0;
        size_type at = 0;
        size_type mask = capacity_ - 1;
        for (at = Hash()(key) & mask; !(states_[at] == used_slot && keys_[at] == key); at = (at + 1) & mask) {
        }
        keys_[at].~Key();
        states_[at] = dead_slot;
        --size_;
        return 1;
    }

    void clear() {
        for (size_type at = 0; at < capacity_; ++at)
            if (states_[at] == used_slot) {
                keys_[at].~Key();
                states_[at] = empty_slot;
            } else {
                states_[at] = empty_slot;
            }
        size_ = 0;
    }

private:
    void release() {
        for (size_type at = 0; at < capacity_; ++at)
            if (states_[at] == used_slot) keys_[at].~Key();
        __console::deallocate(keys_);
        __console::deallocate(states_);
        keys_ = nullptr;
        states_ = nullptr;
        capacity_ = size_ = 0;
    }

    void rehash(size_type wanted) {
        Key* old_keys = keys_;
        State* old_states = states_;
        size_type old_capacity = capacity_;
        keys_ = static_cast<Key*>(__console::allocate(wanted * sizeof(Key)));
        states_ = static_cast<State*>(__console::allocate(wanted * sizeof(State)));
        for (size_type at = 0; at < wanted; ++at) states_[at] = empty_slot;
        capacity_ = wanted;
        size_ = 0;
        size_type mask = capacity_ - 1;
        for (size_type at = 0; at < old_capacity; ++at) {
            if (old_states[at] != used_slot) continue;
            size_type to = Hash()(old_keys[at]) & mask;
            while (states_[to] == used_slot) to = (to + 1) & mask;
            ::new (static_cast<void*>(&keys_[to])) Key(move(old_keys[at]));
            states_[to] = used_slot;
            ++size_;
            old_keys[at].~Key();
        }
        __console::deallocate(old_keys);
        __console::deallocate(old_states);
    }

    Key* keys_ = nullptr;
    State* states_ = nullptr;
    size_type capacity_ = 0;
    size_type size_ = 0;

    friend class const_iterator;
};

}  // namespace std

#endif
