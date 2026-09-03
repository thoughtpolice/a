// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// The SDK's <stdlib.h> under the names C++ code expects.

#ifndef CONSOLE_CXX_CSTDLIB
#define CONSOLE_CXX_CSTDLIB

#include <stdlib.h>

namespace std {

using ::size_t;

using ::calloc;
using ::free;
using ::malloc;
using ::realloc;

using ::abort;
using ::exit;
using ::getenv;
using ::putenv;

using ::atof;
using ::atoi;
using ::atol;
using ::atoll;
using ::strtod;
using ::strtol;
using ::strtoll;
using ::strtoul;
using ::strtoull;

using ::abs;
using ::labs;
using ::rand;
using ::srand;

using ::bsearch;
using ::qsort;

}  // namespace std

#endif
