// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// The compiler's <stddef.h> under the names C++ code expects. The types are
// the same ones: this only puts them in the namespace as well.

#ifndef CONSOLE_CXX_CSTDDEF
#define CONSOLE_CXX_CSTDDEF

#include <stddef.h>

namespace std {

using ::max_align_t;
using ::ptrdiff_t;
using ::size_t;

using nullptr_t = decltype(nullptr);

// A byte of storage that is not a character and not a number, so that code
// which means "raw memory" cannot be read as meaning text.
enum class byte : unsigned char {};

}  // namespace std

#endif
