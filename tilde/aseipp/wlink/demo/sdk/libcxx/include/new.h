// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// The allocation operators, over the SDK's allocator. The console has no
// bad_alloc and no new_handler: a guest that cannot get memory has nowhere to
// carry on from, so the throwing forms report it and stop the guest instead.
// Over-aligned allocation is not supported either, and naming align_val_t is
// a compile error rather than a link one for that reason.

#ifndef CONSOLE_CXX_NEW
#define CONSOLE_CXX_NEW

#include <stddef.h>

namespace std {

// The tag that selects the operators which answer with a null pointer, which
// is the pair the containers here use so that running out is theirs to report.
struct nothrow_t {
    explicit nothrow_t() = default;
};

extern const nothrow_t nothrow;

}  // namespace std

[[nodiscard]] void* operator new(size_t size);
[[nodiscard]] void* operator new[](size_t size);
[[nodiscard]] void* operator new(size_t size, const std::nothrow_t&) noexcept;
[[nodiscard]] void* operator new[](size_t size, const std::nothrow_t&) noexcept;

void operator delete(void* memory) noexcept;
void operator delete[](void* memory) noexcept;
void operator delete(void* memory, size_t size) noexcept;
void operator delete[](void* memory, size_t size) noexcept;
void operator delete(void* memory, const std::nothrow_t&) noexcept;
void operator delete[](void* memory, const std::nothrow_t&) noexcept;

// Placement: constructing into memory the caller already has. The compiler
// knows these are the identity and emits no call for them.
[[nodiscard]] inline void* operator new(size_t, void* where) noexcept { return where; }
[[nodiscard]] inline void* operator new[](size_t, void* where) noexcept { return where; }
inline void operator delete(void*, void*) noexcept {}
inline void operator delete[](void*, void*) noexcept {}

#endif
