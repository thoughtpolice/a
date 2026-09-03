// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

#ifndef CONSOLE_LIBC_STDLIB_H
#define CONSOLE_LIBC_STDLIB_H

#include <stddef.h>

#ifdef __cplusplus
extern "C" {
#endif

#define EXIT_SUCCESS 0
#define EXIT_FAILURE 1
#define RAND_MAX 0x7fffffff

void* malloc(size_t size);
void* calloc(size_t count, size_t size);
void* realloc(void* ptr, size_t size);
void free(void* ptr);

_Noreturn void abort(void);
_Noreturn void exit(int status);
_Noreturn void _Exit(int status);
char* getenv(const char* name);
int putenv(char* assignment);

int atoi(const char* string);
long atol(const char* string);
long long atoll(const char* string);
double atof(const char* string);
long strtol(const char* string, char** end, int base);
unsigned long strtoul(const char* string, char** end, int base);
long long strtoll(const char* string, char** end, int base);
unsigned long long strtoull(const char* string, char** end, int base);
double strtod(const char* string, char** end);

int rand(void);
void srand(unsigned seed);
int abs(int value);
long labs(long value);

void qsort(void* base, size_t count, size_t size, int (*compare)(const void*, const void*));
void* bsearch(const void* key, const void* base, size_t count, size_t size,
              int (*compare)(const void*, const void*));

#ifdef __cplusplus
}
#endif

#endif
