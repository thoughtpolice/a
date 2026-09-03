// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#include "console.h"
#include "internal.h"
#include "runtime.h"

void* malloc(size_t size) {
  return console_malloc(size);
}

void* calloc(size_t count, size_t size) {
  if (size && count > SIZE_MAX / size) return NULL;
  void* memory = console_malloc(count * size);
  memset(memory, 0, count * size);
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

_Noreturn void exit(int status) {
  console_libc_flush_standard_streams();
  console_process_exit(status);
}

_Noreturn void _Exit(int status) {
  console_process_exit(status);
}

// The console has no environment: lookups find nothing and assignments are
// accepted and forgotten.
char* getenv(const char* name) {
  (void)name;
  return NULL;
}

int putenv(char* assignment) {
  (void)assignment;
  return 0;
}

// A fixed-seed generator keeps headless runs reproducible.
static uint64_t random_state = 1;

int rand(void) {
  random_state = 6364136223846793005ull * random_state + 1;
  return (int)(random_state >> 33);
}

void srand(unsigned seed) {
  random_state = seed;
}

int abs(int value) {
  return value < 0 ? -value : value;
}

long labs(long value) {
  return value < 0 ? -value : value;
}
