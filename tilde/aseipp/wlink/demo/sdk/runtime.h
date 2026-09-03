// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

#ifndef CONSOLE_RUNTIME_H
#define CONSOLE_RUNTIME_H

#include <stddef.h>
#include <stdint.h>


#ifdef __cplusplus
extern "C" {
#endif

// Applications implement these callbacks; the SDK reactor exports init/frame.
void console_guest_init(void);
int32_t console_guest_frame(uint32_t dt_ms);

// Allocations are aligned to 16 bytes and trap on exhaustion. A zero size
// still returns a unique allocation. console_free(NULL) is a no-op.
void* console_malloc(size_t size);
void console_free(void* ptr);
// Preserves bytes and alignment; a zero size releases an existing allocation.
void* console_realloc(void* ptr, size_t size);


#ifdef __cplusplus
}
#endif

#endif
