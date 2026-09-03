// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

#ifndef CONSOLE_LIBC_INTERNAL_H
#define CONSOLE_LIBC_INTERNAL_H

#include <stdarg.h>
#include <stddef.h>

// The formatting and parsing routines are portable C. They carry a prefix so
// the native tests can link them next to the host's own C library and compare
// the two; the public names are thin wrappers compiled only for the guest.
int console_libc_vsnprintf(char* buffer, size_t size, const char* format, va_list arguments);
int console_libc_snprintf(char* buffer, size_t size, const char* format, ...);
int console_libc_vsscanf(const char* input, const char* format, va_list arguments);
int console_libc_sscanf(const char* input, const char* format, ...);
double console_libc_strtod(const char* text, char** end);
long console_libc_strtol(const char* text, char** end, int base);
unsigned long console_libc_strtoul(const char* text, char** end, int base);
long long console_libc_strtoll(const char* text, char** end, int base);
unsigned long long console_libc_strtoull(const char* text, char** end, int base);
void console_libc_qsort(void* base, size_t count, size_t size,
                        int (*compare)(const void*, const void*));
void* console_libc_bsearch(const void* key, const void* base, size_t count, size_t size,
                           int (*compare)(const void*, const void*));

// Writes pending partial lines of stdout and stderr to the console log.
void console_libc_flush_standard_streams(void);

#endif
