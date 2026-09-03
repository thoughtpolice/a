// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

#include <stddef.h>

#include "internal.h"

static void swap(char* left, char* right, size_t size) {
  for (size_t i = 0; i < size; i++) {
    char temporary = left[i];
    left[i] = right[i];
    right[i] = temporary;
  }
}

static void sift_down(char* base, size_t root, size_t end, size_t size,
                      int (*compare)(const void*, const void*)) {
  for (;;) {
    size_t child = 2 * root + 1;
    if (child >= end) return;
    if (child + 1 < end && compare(base + child * size, base + (child + 1) * size) < 0) child++;
    if (compare(base + root * size, base + child * size) >= 0) return;
    swap(base + root * size, base + child * size, size);
    root = child;
  }
}

// Heapsort: no recursion, no allocation, and a bound of n log n comparisons
// whatever the input looks like.
void console_libc_qsort(void* base, size_t count, size_t size,
                        int (*compare)(const void*, const void*)) {
  char* bytes = base;
  if (count < 2 || size == 0) return;
  for (size_t start = count / 2; start-- > 0;) sift_down(bytes, start, count, size, compare);
  for (size_t end = count; end-- > 1;) {
    swap(bytes, bytes + end * size, size);
    sift_down(bytes, 0, end, size, compare);
  }
}

void* console_libc_bsearch(const void* key, const void* base, size_t count, size_t size,
                           int (*compare)(const void*, const void*)) {
  const char* bytes = base;
  size_t low = 0;
  size_t high = count;
  while (low < high) {
    size_t middle = low + (high - low) / 2;
    const char* candidate = bytes + middle * size;
    int order = compare(key, candidate);
    if (order == 0) return (void*)candidate;
    if (order < 0) {
      high = middle;
    } else {
      low = middle + 1;
    }
  }
  return NULL;
}

#ifndef CONSOLE_LIBC_NATIVE_TEST
void qsort(void* base, size_t count, size_t size, int (*compare)(const void*, const void*)) {
  console_libc_qsort(base, count, size, compare);
}

void* bsearch(const void* key, const void* base, size_t count, size_t size,
              int (*compare)(const void*, const void*)) {
  return console_libc_bsearch(key, base, count, size, compare);
}
#endif
