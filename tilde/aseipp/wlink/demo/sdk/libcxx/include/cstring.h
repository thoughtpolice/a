// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// The SDK's <string.h> under the names C++ code expects.

#ifndef CONSOLE_CXX_CSTRING
#define CONSOLE_CXX_CSTRING

#include <string.h>

namespace std {

using ::size_t;

using ::memchr;
using ::memcmp;
using ::memcpy;
using ::memmove;
using ::memset;

using ::strcat;
using ::strchr;
using ::strcmp;
using ::strcpy;
using ::strcspn;
using ::strerror;
using ::strlen;
using ::strncat;
using ::strncmp;
using ::strncpy;
using ::strpbrk;
using ::strrchr;
using ::strspn;
using ::strstr;
using ::strtok;

}  // namespace std

#endif
