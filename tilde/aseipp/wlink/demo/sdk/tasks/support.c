// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// The C support of the components in the async worlds: allocation through
// the reactor's allocator, which the canonical ABI's `cabi_realloc` shares,
// and the few string routines the generated bindings call.

#include <stdint.h>
#include <stdlib.h>
#include <string.h>

void* console_malloc(size_t size);
void* console_realloc(void* ptr, size_t size);
void console_free(void* ptr);

void* malloc(size_t size) {
  return console_malloc(size);
}

void* calloc(size_t count, size_t size) {
  if (size && count > SIZE_MAX / size) return NULL;
  void* memory = console_malloc(count * size);
  if (memory) memset(memory, 0, count * size);
  return memory;
}

void* realloc(void* ptr, size_t size) {
  return console_realloc(ptr, size);
}

void free(void* ptr) {
  console_free(ptr);
}

_Noreturn void abort(void) {
  __builtin_trap();
}

void* memcpy(void* restrict to, const void* restrict from, size_t count) {
  unsigned char* out = to;
  const unsigned char* in = from;
  while (count--) *out++ = *in++;
  return to;
}

void* memmove(void* to, const void* from, size_t count) {
  unsigned char* out = to;
  const unsigned char* in = from;
  if (out < in) {
    while (count--) *out++ = *in++;
  } else {
    while (count--) out[count] = in[count];
  }
  return to;
}

void* memset(void* to, int value, size_t count) {
  unsigned char* out = to;
  while (count--) *out++ = (unsigned char)value;
  return to;
}

int memcmp(const void* a, const void* b, size_t count) {
  const unsigned char *x = a, *y = b;
  for (; count; count--, x++, y++) {
    if (*x != *y) return *x - *y;
  }
  return 0;
}

size_t strlen(const char* string) {
  size_t length = 0;
  while (string[length]) length++;
  return length;
}

// The C reactor (`runtime.rs`) is the game world's: it defines the game's
// entry points over these. A component of the async worlds exports what its
// own bindings define instead, so nothing calls them.
void console_guest_init(void) {
  __builtin_trap();
}

int32_t console_guest_frame(uint32_t dt_ms) {
  (void)dt_ms;
  __builtin_trap();
}

// wlink componentize embeds each world directly from WIT, so the generated
// bindings do not link a separate component metadata object.
void __component_type_object_force_link_scheduler(void) {}
void __component_type_object_force_link_launcher(void) {}
void __component_type_object_force_link_async_game(void) {}
