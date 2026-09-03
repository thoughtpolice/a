// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

#ifndef CONSOLE_LIBC_STRING_H
#define CONSOLE_LIBC_STRING_H

#include <stddef.h>

#ifdef __cplusplus
extern "C" {
#endif

void* memcpy(void* __restrict__ destination, const void* __restrict__ source, size_t size);
void* memmove(void* destination, const void* source, size_t size);
void* memset(void* destination, int value, size_t size);
int memcmp(const void* left, const void* right, size_t size);
void* memchr(const void* memory, int value, size_t size);

size_t strlen(const char* string);
size_t strnlen(const char* string, size_t limit);
char* strcpy(char* __restrict__ destination, const char* __restrict__ source);
char* strncpy(char* __restrict__ destination, const char* __restrict__ source, size_t size);
char* strcat(char* __restrict__ destination, const char* __restrict__ source);
char* strncat(char* __restrict__ destination, const char* __restrict__ source, size_t size);
int strcmp(const char* left, const char* right);
int strncmp(const char* left, const char* right, size_t size);
int strcasecmp(const char* left, const char* right);
int strncasecmp(const char* left, const char* right, size_t size);
char* strchr(const char* string, int character);
char* strrchr(const char* string, int character);
char* strstr(const char* haystack, const char* needle);
char* strpbrk(const char* string, const char* accept);
size_t strspn(const char* string, const char* accept);
size_t strcspn(const char* string, const char* reject);
char* strtok(char* __restrict__ string, const char* __restrict__ delimiters);
char* strdup(const char* string);
char* strerror(int error);

#ifdef __cplusplus
}
#endif

#endif
