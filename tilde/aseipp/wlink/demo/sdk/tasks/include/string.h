// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// What the generated bindings of the async worlds need from <string.h>.

#ifndef CONSOLE_TASKS_STRING_H
#define CONSOLE_TASKS_STRING_H

#include <stddef.h>

#ifdef __cplusplus
extern "C" {
#endif

void* memcpy(void* restrict to, const void* restrict from, size_t count);
void* memmove(void* to, const void* from, size_t count);
void* memset(void* to, int value, size_t count);
int memcmp(const void* a, const void* b, size_t count);
size_t strlen(const char* string);

#ifdef __cplusplus
}
#endif

#endif
