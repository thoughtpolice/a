// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// Streams over the SDK's seekable files. Reads are buffered, writes go
// straight to the file, and the standard output streams collect lines for
// the console log.
#include <errno.h>
#include <stdarg.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "console.h"
#include "internal.h"
#include "runtime.h"
#include "stream.h"

#define READ_BUFFER 4096
#define LINE_BUFFER 1024

struct console_libc_file {
  void* stream;
  uint32_t log_level;
  bool readable;
  bool writable;
  bool eof;
  bool error;
  unsigned char* buffer;
  size_t buffered;
  size_t consumed;
  char* line;
  size_t line_length;
};

static FILE standard_input;
static FILE standard_output = {.log_level = CONSOLE_SDK_LOG_LEVEL_INFO, .writable = true};
static FILE standard_error = {.log_level = CONSOLE_SDK_LOG_LEVEL_ERROR, .writable = true};

FILE* stdin = &standard_input;
FILE* stdout = &standard_output;
FILE* stderr = &standard_error;

static size_t write_bytes(FILE* file, const unsigned char* data, size_t size);

static bool is_log_stream(FILE* file) {
  return file == &standard_output || file == &standard_error;
}

static void flush_line(FILE* file) {
  if (file->line_length) console_log(file->log_level, file->line, file->line_length);
  file->line_length = 0;
}

static void log_write(FILE* file, const unsigned char* data, size_t size) {
  if (!file->line) file->line = console_malloc(LINE_BUFFER);
  for (size_t i = 0; i < size; i++) {
    if (data[i] == '\n') {
      flush_line(file);
      continue;
    }
    file->line[file->line_length++] = (char)data[i];
    if (file->line_length == LINE_BUFFER) flush_line(file);
  }
}

void console_libc_flush_standard_streams(void) {
  flush_line(&standard_output);
  flush_line(&standard_error);
}

static size_t unread(const FILE* file) {
  return file->buffered - file->consumed;
}

// Moves the underlying position back over buffered bytes that were never
// consumed, so a write or a relative seek starts where the caller thinks.
static bool discard_buffer(FILE* file) {
  size_t pending = unread(file);
  file->buffered = 0;
  file->consumed = 0;
  return pending == 0 || console_stream_seek(file->stream, -(int)pending, 1) == 0;
}

// Appending is a rewrite: the file resource has no append mode, so the
// existing contents are read back before the write open truncates the file
// and written out again ahead of the cursor.
static unsigned char* read_existing(const char* path, size_t* size) {
  void* old = console_stream_open(path, "rb");
  *size = 0;
  if (!old) return NULL;
  size_t capacity = READ_BUFFER;
  unsigned char* data = console_malloc(capacity);
  for (;;) {
    if (*size == capacity) {
      capacity *= 2;
      data = console_realloc(data, capacity);
    }
    int received = console_stream_read(old, data + *size, (int)(capacity - *size));
    if (received <= 0) break;
    *size += (size_t)received;
  }
  console_stream_close(old);
  return data;
}

FILE* fopen(const char* path, const char* mode) {
  char kind = mode ? mode[0] : '\0';
  if (kind != 'r' && kind != 'w' && kind != 'a') {
    errno = EINVAL;
    return NULL;
  }
  for (const char* m = mode + 1; *m; m++) {
    if (*m != 'b') {
      errno = EINVAL;
      return NULL;
    }
  }
  size_t existing_size = 0;
  unsigned char* existing = kind == 'a' ? read_existing(path, &existing_size) : NULL;
  void* stream = console_stream_open(path, kind == 'r' ? "rb" : "wb");
  if (!stream) {
    console_free(existing);
    errno = ENOENT;
    return NULL;
  }
  FILE* file = console_malloc(sizeof *file);
  memset(file, 0, sizeof *file);
  file->stream = stream;
  file->readable = kind == 'r';
  file->writable = kind != 'r';
  if (existing) {
    size_t written = write_bytes(file, existing, existing_size);
    console_free(existing);
    if (written != existing_size) {
      fclose(file);
      errno = EIO;
      return NULL;
    }
  }
  return file;
}

int fclose(FILE* file) {
  if (!file) return EOF;
  if (is_log_stream(file)) {
    flush_line(file);
    return 0;
  }
  if (file == &standard_input) return 0;
  console_stream_close(file->stream);
  console_free(file->buffer);
  console_free(file);
  return 0;
}

int fflush(FILE* file) {
  if (!file) {
    console_libc_flush_standard_streams();
    return 0;
  }
  if (is_log_stream(file)) flush_line(file);
  return 0;
}

static size_t read_bytes(FILE* file, unsigned char* destination, size_t size) {
  if (!file->readable || !file->stream) {
    file->eof = true;
    return 0;
  }
  size_t total = 0;
  size_t available = unread(file);
  if (available) {
    size_t take = available < size ? available : size;
    memcpy(destination, file->buffer + file->consumed, take);
    file->consumed += take;
    total += take;
  }
  while (total < size) {
    size_t wanted = size - total;
    if (wanted >= READ_BUFFER) {
      int received = console_stream_read(file->stream, destination + total, (int)wanted);
      if (received < 0) {
        file->error = true;
        break;
      }
      total += (size_t)received;
      if ((size_t)received < wanted) {
        file->eof = true;
        break;
      }
      continue;
    }
    if (!file->buffer) file->buffer = console_malloc(READ_BUFFER);
    int received = console_stream_read(file->stream, file->buffer, READ_BUFFER);
    if (received < 0) {
      file->error = true;
      break;
    }
    file->buffered = (size_t)received;
    file->consumed = 0;
    if (received == 0) {
      file->eof = true;
      break;
    }
    size_t take = (size_t)received < wanted ? (size_t)received : wanted;
    memcpy(destination + total, file->buffer, take);
    file->consumed = take;
    total += take;
    if ((size_t)received < READ_BUFFER && take == (size_t)received && total < size) {
      file->eof = true;
      break;
    }
  }
  return total;
}

size_t fread(void* buffer, size_t size, size_t count, FILE* file) {
  if (!file || size == 0 || count == 0) return 0;
  size_t received = read_bytes(file, buffer, size * count);
  return received / size;
}

static size_t write_bytes(FILE* file, const unsigned char* data, size_t size) {
  if (is_log_stream(file)) {
    log_write(file, data, size);
    return size;
  }
  if (!file->writable || !file->stream || !discard_buffer(file)) {
    file->error = true;
    return 0;
  }
  size_t total = 0;
  while (total < size) {
    size_t chunk = size - total < 65536 ? size - total : 65536;
    int written = console_stream_write(file->stream, data + total, (int)chunk);
    if (written <= 0) {
      file->error = true;
      break;
    }
    total += (size_t)written;
  }
  return total;
}

size_t fwrite(const void* buffer, size_t size, size_t count, FILE* file) {
  if (!file || size == 0 || count == 0) return 0;
  return write_bytes(file, buffer, size * count) / size;
}

int fseek(FILE* file, long offset, int origin) {
  if (!file || !file->stream) return -1;
  if (origin == SEEK_CUR) offset -= (long)unread(file);
  file->buffered = 0;
  file->consumed = 0;
  if (console_stream_seek(file->stream, (int)offset, origin) != 0) return -1;
  file->eof = false;
  return 0;
}

long ftell(FILE* file) {
  if (!file || !file->stream) return -1;
  int position = console_stream_tell(file->stream);
  if (position < 0) return -1;
  return position - (long)unread(file);
}

void rewind(FILE* file) {
  if (fseek(file, 0, SEEK_SET) == 0) file->error = false;
}

int feof(FILE* file) {
  return file && file->eof;
}

int ferror(FILE* file) {
  return file && file->error;
}

void clearerr(FILE* file) {
  if (!file) return;
  file->eof = false;
  file->error = false;
}

int fgetc(FILE* file) {
  unsigned char byte;
  return read_bytes(file, &byte, 1) == 1 ? byte : EOF;
}

int getc(FILE* file) {
  return fgetc(file);
}

char* fgets(char* buffer, int size, FILE* file) {
  if (!buffer || size <= 0) return NULL;
  int length = 0;
  while (length < size - 1) {
    int c = fgetc(file);
    if (c == EOF) break;
    buffer[length++] = (char)c;
    if (c == '\n') break;
  }
  if (length == 0) return NULL;
  buffer[length] = '\0';
  return buffer;
}

int fputc(int character, FILE* file) {
  unsigned char byte = (unsigned char)character;
  return file && write_bytes(file, &byte, 1) == 1 ? byte : EOF;
}

int putc(int character, FILE* file) {
  return fputc(character, file);
}

int putchar(int character) {
  return fputc(character, stdout);
}

int fputs(const char* string, FILE* file) {
  size_t length = strlen(string);
  return file && write_bytes(file, (const unsigned char*)string, length) == length ? 0 : EOF;
}

int puts(const char* string) {
  return fputs(string, stdout) == 0 && fputc('\n', stdout) == '\n' ? 0 : EOF;
}

// The SDK reports only success or failure; a failure is reported as a
// missing file, the usual reason.
int remove(const char* path) {
  if (path && console_files_remove(path, strlen(path))) return 0;
  errno = ENOENT;
  return -1;
}

int rename(const char* from, const char* to) {
  if (from && to && console_files_rename(from, strlen(from), to, strlen(to))) return 0;
  errno = ENOENT;
  return -1;
}

void perror(const char* prefix) {
  if (prefix && *prefix) {
    fprintf(stderr, "%s: %s\n", prefix, strerror(errno));
  } else {
    fprintf(stderr, "%s\n", strerror(errno));
  }
}

int vfprintf(FILE* file, const char* format, va_list arguments) {
  char local[512];
  va_list copy;
  va_copy(copy, arguments);
  int length = console_libc_vsnprintf(local, sizeof local, format, copy);
  va_end(copy);
  if (length < 0) return -1;
  if ((size_t)length < sizeof local) {
    return write_bytes(file, (const unsigned char*)local, (size_t)length) == (size_t)length ? length : -1;
  }
  char* heap = console_malloc((size_t)length + 1);
  console_libc_vsnprintf(heap, (size_t)length + 1, format, arguments);
  size_t written = write_bytes(file, (const unsigned char*)heap, (size_t)length);
  console_free(heap);
  return written == (size_t)length ? length : -1;
}

int fprintf(FILE* file, const char* format, ...) {
  va_list arguments;
  va_start(arguments, format);
  int result = vfprintf(file, format, arguments);
  va_end(arguments);
  return result;
}

int vprintf(const char* format, va_list arguments) {
  return vfprintf(stdout, format, arguments);
}

int printf(const char* format, ...) {
  va_list arguments;
  va_start(arguments, format);
  int result = vfprintf(stdout, format, arguments);
  va_end(arguments);
  return result;
}
