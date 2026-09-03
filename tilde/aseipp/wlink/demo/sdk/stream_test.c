// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

#include "console.h"
#include "stream.h"
#include "runtime.h"

#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define CHECK(condition) do { \
  if (!(condition)) { \
    fprintf(stderr, "stream_test:%d: %s\n", __LINE__, #condition); \
    return 1; \
  } \
} while (0)

enum { CAPACITY = 140000 };
static uint8_t storage[CAPACITY];
static size_t storage_size;
static bool handles[4];
static unsigned guest_allocations;
static unsigned returned_allocations;
static unsigned read_calls;
static unsigned write_calls;
static unsigned open_calls;
static unsigned fail_read_call;
static bool fail_size;
static bool malformed_read;

void* console_malloc(size_t size) {
  void* ptr = malloc(size);
  if (!ptr) abort();
  ++guest_allocations;
  return ptr;
}

void console_free(void* ptr) {
  if (!ptr) return;
  if (!guest_allocations) abort();
  --guest_allocations;
  free(ptr);
}

bool console_files_open(const char* path, size_t len, bool write,
                        console_file* file) {
  ++open_calls;
  if (len != 5 || memcmp(path, "asset", 5) != 0) return false;
  for (unsigned i = 0; i < 4; ++i) {
    if (handles[i]) continue;
    handles[i] = true;
    if (write) storage_size = 0;
    file->__handle = (int32_t)i;
    return true;
  }
  return false;
}

static bool open_handle(console_file file) {
  return file.__handle >= 0 && file.__handle < 4 && handles[file.__handle];
}

void console_file_close(console_file file) {
  if (!open_handle(file)) abort();
  handles[file.__handle] = false;
}

int64_t console_file_size(console_file file) {
  if (!open_handle(file) || fail_size) return -1;
  return (int64_t)storage_size;
}

console_file_read_result console_file_read_at(console_file file,
                                              uint64_t offset,
                                              uint32_t length) {
  console_file_read_result result = {0};
  ++read_calls;
  if (!open_handle(file) || read_calls == fail_read_call) {
    result.status = -1;
    return result;
  }
  if (offset >= storage_size) return result;
  size_t count = storage_size - (size_t)offset;
  if (count > length) count = length;
  if (malformed_read) count = (size_t)length + 1;
  result.data.data = malloc(count);
  if (!result.data.data) abort();
  ++returned_allocations;
  result.data.len = count;
  if (!malformed_read) memcpy(result.data.data, storage + offset, count);
  return result;
}

void console_free_bytes(console_bytes* bytes) {
  if (bytes->data) {
    if (!returned_allocations) abort();
    --returned_allocations;
    free(bytes->data);
  }
  bytes->data = NULL;
  bytes->len = 0;
}

int32_t console_file_write_at(console_file file, uint64_t offset,
                             const uint8_t* data, size_t len) {
  ++write_calls;
  if (!open_handle(file) || offset > CAPACITY) return -1;
  size_t count = CAPACITY - (size_t)offset;
  if (count > len) count = len;
  memcpy(storage + offset, data, count);
  if (offset + count > storage_size) storage_size = (size_t)offset + count;
  return (int32_t)count;
}

int main(void) {
  uint8_t buffer[CAPACITY + 1];
  for (unsigned i = 0; i < CAPACITY; ++i) storage[i] = (uint8_t)(i * 37);
  storage_size = CAPACITY;

  void* file = console_stream_open("asset", "rb");
  CHECK(file && handles[0]);
  CHECK(!console_stream_eof(file));
  CHECK(console_stream_read(file, NULL, 0) == 0);
  CHECK(console_stream_read(file, buffer, CAPACITY + 1) == CAPACITY);
  CHECK(read_calls == 3);
  CHECK(memcmp(buffer, storage, CAPACITY) == 0);
  CHECK(console_stream_tell(file) == CAPACITY && console_stream_eof(file));
  CHECK(returned_allocations == 0);

  CHECK(console_stream_seek(file, -3, 2) == 0);
  CHECK(!console_stream_eof(file) && console_stream_tell(file) == CAPACITY - 3);
  CHECK(console_stream_read(file, buffer, 5) == 3 && console_stream_eof(file));
  CHECK(console_stream_seek(file, 0, 0) == 0 && !console_stream_eof(file));
  CHECK(console_stream_seek(file, -1, 1) == -1 && console_stream_tell(file) == 0);
  CHECK(console_stream_seek(file, 1, 17) == -1 && console_stream_tell(file) == 0);
  fail_size = true;
  CHECK(console_stream_seek(file, 0, 2) == -1 && console_stream_tell(file) == 0);
  fail_size = false;
  CHECK(console_stream_seek(file, INT_MAX, 0) == 0);
  CHECK(console_stream_tell(file) == INT_MAX);
  CHECK(console_stream_seek(file, 1, 1) == 0 && console_stream_tell(file) == -1);
  CHECK(console_stream_seek(file, INT_MIN, 1) == 0 && console_stream_tell(file) == 0);

  // Opening a second stream must not share the first stream's cursor.
  void* second = console_stream_open("asset", "r");
  CHECK(second && console_stream_read(file, buffer, 7) == 7);
  CHECK(console_stream_tell(second) == 0);
  CHECK(console_stream_read(second, buffer, 2) == 2);
  CHECK(buffer[0] == storage[0] && buffer[1] == storage[1]);
  CHECK(console_stream_tell(file) == 7);
  console_stream_close(second);

  CHECK(console_stream_seek(file, 0, 0) == 0);
  fail_read_call = read_calls + 2;
  CHECK(console_stream_read(file, buffer, CAPACITY) == 65536);
  CHECK(console_stream_tell(file) == 65536 && !console_stream_eof(file));
  CHECK(returned_allocations == 0);
  fail_read_call = read_calls + 1;
  CHECK(console_stream_read(file, buffer, 1) == -1);
  CHECK(console_stream_tell(file) == 65536);
  fail_read_call = 0;
  malformed_read = true;
  CHECK(console_stream_read(file, buffer, 1) == -1);
  CHECK(console_stream_tell(file) == 65536 && returned_allocations == 0);
  malformed_read = false;
  CHECK(console_stream_write(file, buffer, 1) == -1);
  CHECK(console_stream_read(file, buffer, -1) == -1);
  console_stream_close(file);
  CHECK(guest_allocations == 0 && !handles[0]);

  file = console_stream_open("asset", "wb");
  CHECK(file && storage_size == 0);
  for (unsigned i = 0; i < CAPACITY; ++i) buffer[i] = (uint8_t)(i * 19);
  CHECK(console_stream_write(file, buffer, CAPACITY) == CAPACITY);
  CHECK(write_calls == 3 && storage_size == CAPACITY);
  CHECK(memcmp(buffer, storage, CAPACITY) == 0);
  CHECK(console_stream_write(file, buffer, 1) == 0);
  CHECK(console_stream_tell(file) == CAPACITY);
  CHECK(console_stream_seek(file, -2, 2) == 0);
  CHECK(console_stream_write(file, "ok", 2) == 2);
  CHECK(memcmp(storage + CAPACITY - 2, "ok", 2) == 0);
  CHECK(console_stream_read(file, buffer, 1) == -1);
  console_stream_close(file);

  CHECK(!console_stream_open("missing", "r"));
  unsigned old_open_calls = open_calls;
  CHECK(!console_stream_open("asset", ""));
  CHECK(!console_stream_open("asset", "a"));
  CHECK(!console_stream_open("asset", "r+"));
  CHECK(open_calls == old_open_calls);
  CHECK(console_stream_read(NULL, buffer, 1) == -1);
  CHECK(console_stream_seek(NULL, 0, 0) == -1);
  console_stream_close(NULL);
  CHECK(guest_allocations == 0 && returned_allocations == 0);
  puts("Console SDK stream tests passed");
  return 0;
}
