// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// What the generated bindings of the async worlds need from <stdlib.h>, for
// components built without the SDK's libc, which is bound to the game world.

#ifndef CONSOLE_TASKS_STDLIB_H
#define CONSOLE_TASKS_STDLIB_H

#include <stddef.h>

#ifdef __cplusplus
extern "C" {
#endif

void* malloc(size_t size);
void* calloc(size_t count, size_t size);
void* realloc(void* ptr, size_t size);
void free(void* ptr);
_Noreturn void abort(void);

#ifdef __cplusplus
}
#endif

#endif
