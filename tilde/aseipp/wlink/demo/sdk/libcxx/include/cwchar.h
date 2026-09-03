// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// Shadows the compiler's <cwchar>, which reaches for the host's wchar.h and
// with it a second definition of FILE. The console has no wide character I/O;
// these are the six routines char_traits<wchar_t> names, declared so the
// narrow specialisations the guest does use can be compiled.

#ifndef CONSOLE_CXX_CWCHAR
#define CONSOLE_CXX_CWCHAR

#include <stddef.h>

typedef struct {
    int __count;
    unsigned int __value;
} mbstate_t;

typedef int wint_t;

#define WEOF ((wint_t)-1)

extern "C" {
int wmemcmp(const wchar_t* left, const wchar_t* right, size_t count);
wchar_t* wmemcpy(wchar_t* destination, const wchar_t* source, size_t count);
wchar_t* wmemmove(wchar_t* destination, const wchar_t* source, size_t count);
wchar_t* wmemset(wchar_t* destination, wchar_t value, size_t count);
const wchar_t* wmemchr(const wchar_t* text, wchar_t value, size_t count);
size_t wcslen(const wchar_t* text);
}

namespace std {
using ::mbstate_t;
using ::wint_t;
using ::wcslen;
using ::wmemchr;
using ::wmemcmp;
using ::wmemcpy;
using ::wmemmove;
using ::wmemset;
}  // namespace std

#endif
