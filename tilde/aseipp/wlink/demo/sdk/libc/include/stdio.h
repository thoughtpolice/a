// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

#ifndef CONSOLE_LIBC_STDIO_H
#define CONSOLE_LIBC_STDIO_H

#include <stdarg.h>
#include <stddef.h>

#ifdef __cplusplus
extern "C" {
#endif

// Streams wrap the SDK's seekable streams over positional file resources;
// stdout and stderr write lines to the console log, stdin is always at its
// end, and the modes are r, w, and a with an optional b.
typedef struct console_libc_file FILE;

extern FILE* stdin;
extern FILE* stdout;
extern FILE* stderr;

#define EOF (-1)
#define BUFSIZ 1024
#define FILENAME_MAX 256
#define FOPEN_MAX 64
#define SEEK_SET 0
#define SEEK_CUR 1
#define SEEK_END 2

FILE* fopen(const char* path, const char* mode);
int fclose(FILE* stream);
int fflush(FILE* stream);
size_t fread(void* buffer, size_t size, size_t count, FILE* stream);
size_t fwrite(const void* buffer, size_t size, size_t count, FILE* stream);
int fseek(FILE* stream, long offset, int origin);
long ftell(FILE* stream);
void rewind(FILE* stream);
int feof(FILE* stream);
int ferror(FILE* stream);
void clearerr(FILE* stream);
int fgetc(FILE* stream);
int getc(FILE* stream);
char* fgets(char* buffer, int size, FILE* stream);
int fputc(int character, FILE* stream);
int putc(int character, FILE* stream);
int putchar(int character);
int fputs(const char* string, FILE* stream);
int puts(const char* string);
int remove(const char* path);
int rename(const char* from, const char* to);
void perror(const char* prefix);

int printf(const char* format, ...) __attribute__((format(printf, 1, 2)));
int fprintf(FILE* stream, const char* format, ...) __attribute__((format(printf, 2, 3)));
int sprintf(char* buffer, const char* format, ...) __attribute__((format(printf, 2, 3)));
int snprintf(char* buffer, size_t size, const char* format, ...) __attribute__((format(printf, 3, 4)));
int vprintf(const char* format, va_list arguments);
int vfprintf(FILE* stream, const char* format, va_list arguments);
int vsprintf(char* buffer, const char* format, va_list arguments);
int vsnprintf(char* buffer, size_t size, const char* format, va_list arguments);
int sscanf(const char* string, const char* format, ...) __attribute__((format(scanf, 2, 3)));
int vsscanf(const char* string, const char* format, va_list arguments);

#ifdef __cplusplus
}
#endif

#endif
