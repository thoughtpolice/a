// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// Model memory for the software renderer. The engine reserves a generous
// hunk per model, fills part of it, and keeps only what it used, so the
// reservations come from large slabs and each hunk's unused tail goes back
// at Hunk_End: a level costs what its models weigh, not what they might have.
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <string.h>

#ifdef HUNK_NATIVE_TEST
#include <stdlib.h>
#define console_malloc malloc
#define console_free free
#else
#include "runtime.h"
#endif

void Sys_Error(char* error, ...);

void* Hunk_Begin(int maxsize);
void* Hunk_Alloc(int size);
int Hunk_End(void);
void Hunk_Free(void* base);

#define ALIGNMENT 32
#define SLAB_SIZE (32u << 20)

// Every block starts with a header and covers `size` bytes including it;
// blocks tile a slab from its first block to the one marked last.
typedef struct block {
  size_t size;
  struct block* previous;
  bool free;
  bool last;
  struct block* next_free;
  struct block* previous_free;
} block;

#define HEADER ((sizeof(block) + ALIGNMENT - 1) & ~(size_t)(ALIGNMENT - 1))

static block* free_list;
static block* current;
static size_t reserved;
static size_t used;

static block* next_block(block* b) {
  return b->last ? NULL : (block*)((char*)b + b->size);
}

static void insert_free(block* b) {
  b->free = true;
  b->previous_free = NULL;
  b->next_free = free_list;
  if (free_list) free_list->previous_free = b;
  free_list = b;
}

static void remove_free(block* b) {
  if (b->previous_free) {
    b->previous_free->next_free = b->next_free;
  } else {
    free_list = b->next_free;
  }
  if (b->next_free) b->next_free->previous_free = b->previous_free;
  b->free = false;
}

// Absorbs the following block into `b`.
static void merge_next(block* b) {
  block* next = next_block(b);
  b->size += next->size;
  b->last = next->last;
  block* after = next_block(b);
  if (after) after->previous = b;
}

// Cuts `b` down to `size` bytes; the remainder becomes a free block, joined
// with a free neighbour when there is one.
static void split(block* b, size_t size) {
  if (b->size < size + HEADER + ALIGNMENT) return;
  block* rest = (block*)((char*)b + size);
  rest->size = b->size - size;
  rest->previous = b;
  rest->last = b->last;
  b->size = size;
  b->last = false;
  block* after = next_block(rest);
  if (after) {
    after->previous = rest;
    if (after->free) {
      remove_free(after);
      merge_next(rest);
    }
  }
  insert_free(rest);
}

static void release(block* b) {
  block* next = next_block(b);
  if (next && next->free) {
    remove_free(next);
    merge_next(b);
  }
  if (b->previous && b->previous->free) {
    block* previous = b->previous;
    remove_free(previous);
    merge_next(previous);
    b = previous;
  }
  if (!b->previous && b->last) {
    console_free(b);
    return;
  }
  insert_free(b);
}

static block* acquire(size_t size) {
  for (block* b = free_list; b; b = b->next_free) {
    if (b->size >= size) {
      remove_free(b);
      return b;
    }
  }
  size_t slab_size = size + HEADER > SLAB_SIZE ? size + HEADER : SLAB_SIZE;
  block* slab = console_malloc(slab_size);
  if (!slab) Sys_Error("Hunk_Begin: out of memory");
  slab->size = slab_size;
  slab->previous = NULL;
  slab->free = false;
  slab->last = true;
  return slab;
}

void* Hunk_Begin(int maxsize) {
  if (current) Sys_Error("Hunk_Begin: a hunk is already open");
  if (maxsize < 0) Sys_Error("Hunk_Begin: negative size");
  reserved = ((size_t)maxsize + ALIGNMENT - 1) & ~(size_t)(ALIGNMENT - 1);
  current = acquire(HEADER + reserved);
  split(current, HEADER + reserved);
  used = 0;
  return (char*)current + HEADER;
}

void* Hunk_Alloc(int size) {
  if (!current) Sys_Error("Hunk_Alloc: no hunk is open");
  if (size < 0) Sys_Error("Hunk_Alloc: negative size");
  size_t rounded = ((size_t)size + ALIGNMENT - 1) & ~(size_t)(ALIGNMENT - 1);
  if (rounded > reserved - used) Sys_Error("Hunk_Alloc overflow");
  void* memory = (char*)current + HEADER + used;
  used += rounded;
  memset(memory, 0, rounded);
  return memory;
}

int Hunk_End(void) {
  if (!current) Sys_Error("Hunk_End: no hunk is open");
  split(current, HEADER + used);
  current = NULL;
  return (int)used;
}

void Hunk_Free(void* base) {
  if (!base) return;
  release((block*)((char*)base - HEADER));
}
