// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

#include "stream.h"
#include "runtime.h"
#include "console.h"

#include <limits.h>

typedef struct {
  console_file file;
  uint64_t position;
  bool eof;
  bool writable;
} console_stream;

enum { IO_CHUNK = 65536 };

void* console_stream_open(const char* path, const char* mode) {
  if (!path || !mode || (mode[0] != 'r' && mode[0] != 'w') ||
      (mode[1] != '\0' && (mode[1] != 'b' || mode[2] != '\0')))
    return NULL;
  size_t len = 0;
  while (path[len]) ++len;
  bool writable = mode[0] == 'w';
  console_file opened;
  if (!console_files_open(path, len, writable, &opened)) return NULL;
  console_stream* file = console_malloc(sizeof(*file));
  file->file = opened;
  file->position = 0;
  file->eof = false;
  file->writable = writable;
  return file;
}

void console_stream_close(void* opaque) {
  console_stream* file = opaque;
  if (!file) return;
  console_file_close(file->file);
  console_free(file);
}

int console_stream_read(void* opaque, void* buffer, int count) {
  console_stream* file = opaque;
  if (!file || count < 0 || (count && !buffer) || file->writable) return -1;
  uint8_t* destination = buffer;
  int total = 0;
  while (total < count) {
    uint32_t request = (uint32_t)(count - total);
    if (request > IO_CHUNK) request = IO_CHUNK;
    console_file_read_result result =
        console_file_read_at(file->file, file->position, request);
    if (result.status != 0 || result.data.len > request ||
        (result.data.len != 0 && result.data.data == NULL)) {
      console_free_bytes(&result.data);
      return total ? total : -1;
    }
    size_t received = result.data.len;
    for (size_t i = 0; i < received; ++i)
      destination[total + i] = result.data.data[i];
    console_free_bytes(&result.data);
    file->position += received;
    total += (int)received;
    if (received < request) {
      file->eof = true;
      break;
    }
  }
  return total;
}

int console_stream_write(void* opaque, const void* buffer, int count) {
  console_stream* file = opaque;
  if (!file || count < 0 || (count && !buffer) || !file->writable) return -1;
  const uint8_t* source = buffer;
  int total = 0;
  while (total < count) {
    size_t request = (size_t)(count - total);
    if (request > IO_CHUNK) request = IO_CHUNK;
    int32_t written = console_file_write_at(
        file->file, file->position, source + total, request);
    if (written < 0 || (size_t)written > request)
      return total ? total : -1;
    file->position += (uint32_t)written;
    total += written;
    if ((size_t)written < request) break;
  }
  return total;
}

int console_stream_seek(void* opaque, int offset, int origin) {
  console_stream* file = opaque;
  if (!file) return -1;
  uint64_t base;
  switch (origin) {
    case 0: base = 0; break;
    case 1: base = file->position; break;
    case 2: {
      int64_t size = console_file_size(file->file);
      if (size < 0) return -1;
      base = (uint64_t)size;
      break;
    }
    default: return -1;
  }
  if (offset < 0) {
    uint64_t amount = (uint64_t)-(int64_t)offset;
    if (base < amount) return -1;
    file->position = base - amount;
  } else {
    if (base > UINT64_MAX - (uint32_t)offset) return -1;
    file->position = base + (uint32_t)offset;
  }
  file->eof = false;
  return 0;
}

int console_stream_tell(void* opaque) {
  console_stream* file = opaque;
  if (!file || file->position > INT_MAX) return -1;
  return (int)file->position;
}

int console_stream_eof(void* opaque) {
  console_stream* file = opaque;
  return !file || file->eof;
}
