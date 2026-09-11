// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// The hunk allocator under the renderer's pattern: reserve, fill, keep the
// used part, free at level change.
#include <stdarg.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

void* Hunk_Begin(int maxsize);
void* Hunk_Alloc(int size);
int Hunk_End(void);
void Hunk_Free(void* base);

static int failures;

void Sys_Error(char* error, ...) {
  va_list arguments;
  va_start(arguments, error);
  vfprintf(stderr, error, arguments);
  va_end(arguments);
  fputc('\n', stderr);
  exit(2);
}

static void require(int condition, const char* what) {
  if (!condition) {
    failures++;
    fprintf(stderr, "FAIL hunk %s\n", what);
  }
}

// Every hunk is a fresh reservation; the used part must survive intact.
static void* model(int reserve, int chunks, int chunk, int* total) {
  char* base = Hunk_Begin(reserve);
  *total = 0;
  for (int i = 0; i < chunks; i++) {
    unsigned char* memory = Hunk_Alloc(chunk);
    require(memory == (unsigned char*)base + *total, "allocations are contiguous from the base");
    for (int j = 0; j < chunk; j++) require(memory[j] == 0, "allocations are zeroed");
    memset(memory, (int)(i + 1), (size_t)chunk);
    *total += (chunk + 31) & ~31;
  }
  int size = Hunk_End();
  require(size == *total, "Hunk_End reports the used size");
  return base;
}

int main(void) {
  int used;
  void* first = model(16 << 20, 100, 50000, &used);
  require(used == 100 * 50016, "first model size");
  void* models[120];
  int sizes[120];
  for (int i = 0; i < 120; i++) models[i] = model(2 << 20, 7, 20000 + i * 100, &sizes[i]);
  for (int i = 0; i < 120; i++) {
    unsigned char* memory = models[i];
    int last = sizes[i] - ((20000 + i * 100 + 31) & ~31);
    require(memory[0] == 1 && memory[last] == 7, "model contents survive later hunks");
  }
  for (int i = 0; i < 120; i += 2) Hunk_Free(models[i]);
  int* small = Hunk_Begin(4096);
  int* value = Hunk_Alloc(sizeof *value);
  *value = 42;
  require(Hunk_End() == 32 && *small == 42, "a hunk fits in a freed gap");
  Hunk_Free(small);
  for (int i = 1; i < 120; i += 2) Hunk_Free(models[i]);
  Hunk_Free(first);
  Hunk_Free(NULL);
  void* again = model(16 << 20, 3, 100, &used);
  require(again == first, "an empty allocator reuses the first slab address");
  Hunk_Free(again);
  char* empty = Hunk_Begin(1 << 20);
  require(Hunk_End() == 0 && empty != NULL, "an empty hunk is allowed");
  Hunk_Free(empty);
  printf("%s\n", failures ? "hunk tests failed" : "hunk tests passed");
  return failures ? 1 : 0;
}
