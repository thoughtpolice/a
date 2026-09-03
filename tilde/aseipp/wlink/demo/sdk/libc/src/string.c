// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

#include <errno.h>
#include <stdlib.h>
#include <string.h>

#include "internal.h"

// The builtins lower to the bulk memory instructions; the compiler never
// turns them back into calls to these functions.
void* memcpy(void* restrict destination, const void* restrict source, size_t size) {
  return __builtin_memcpy(destination, source, size);
}

void* memmove(void* destination, const void* source, size_t size) {
  return __builtin_memmove(destination, source, size);
}

void* memset(void* destination, int value, size_t size) {
  return __builtin_memset(destination, value, size);
}

int memcmp(const void* left, const void* right, size_t size) {
  const unsigned char* a = left;
  const unsigned char* b = right;
  for (size_t i = 0; i < size; i++) {
    if (a[i] != b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return 0;
}

void* memchr(const void* memory, int value, size_t size) {
  const unsigned char* bytes = memory;
  for (size_t i = 0; i < size; i++) {
    if (bytes[i] == (unsigned char)value) return (void*)(bytes + i);
  }
  return NULL;
}

size_t strlen(const char* string) {
  size_t length = 0;
  while (string[length]) length++;
  return length;
}

size_t strnlen(const char* string, size_t limit) {
  size_t length = 0;
  while (length < limit && string[length]) length++;
  return length;
}

char* strcpy(char* restrict destination, const char* restrict source) {
  size_t i = 0;
  do {
    destination[i] = source[i];
  } while (source[i++]);
  return destination;
}

char* strncpy(char* restrict destination, const char* restrict source, size_t size) {
  size_t i = 0;
  while (i < size && source[i]) {
    destination[i] = source[i];
    i++;
  }
  while (i < size) destination[i++] = '\0';
  return destination;
}

char* strcat(char* restrict destination, const char* restrict source) {
  strcpy(destination + strlen(destination), source);
  return destination;
}

char* strncat(char* restrict destination, const char* restrict source, size_t size) {
  size_t length = strlen(destination);
  size_t i = 0;
  while (i < size && source[i]) {
    destination[length + i] = source[i];
    i++;
  }
  destination[length + i] = '\0';
  return destination;
}

int strcmp(const char* left, const char* right) {
  const unsigned char* a = (const unsigned char*)left;
  const unsigned char* b = (const unsigned char*)right;
  while (*a && *a == *b) {
    a++;
    b++;
  }
  return *a < *b ? -1 : *a > *b;
}

int strncmp(const char* left, const char* right, size_t size) {
  const unsigned char* a = (const unsigned char*)left;
  const unsigned char* b = (const unsigned char*)right;
  for (size_t i = 0; i < size; i++) {
    if (a[i] != b[i]) return a[i] < b[i] ? -1 : 1;
    if (!a[i]) return 0;
  }
  return 0;
}

static int fold(unsigned char c) {
  return c >= 'A' && c <= 'Z' ? c + ('a' - 'A') : c;
}

int strcasecmp(const char* left, const char* right) {
  const unsigned char* a = (const unsigned char*)left;
  const unsigned char* b = (const unsigned char*)right;
  while (*a && fold(*a) == fold(*b)) {
    a++;
    b++;
  }
  return fold(*a) - fold(*b);
}

int strncasecmp(const char* left, const char* right, size_t size) {
  const unsigned char* a = (const unsigned char*)left;
  const unsigned char* b = (const unsigned char*)right;
  for (size_t i = 0; i < size; i++) {
    int difference = fold(a[i]) - fold(b[i]);
    if (difference) return difference;
    if (!a[i]) return 0;
  }
  return 0;
}

char* strchr(const char* string, int character) {
  for (;; string++) {
    if (*string == (char)character) return (char*)string;
    if (!*string) return NULL;
  }
}

char* strrchr(const char* string, int character) {
  const char* found = NULL;
  for (;; string++) {
    if (*string == (char)character) found = string;
    if (!*string) return (char*)found;
  }
}

char* strstr(const char* haystack, const char* needle) {
  size_t length = strlen(needle);
  if (length == 0) return (char*)haystack;
  for (; *haystack; haystack++) {
    if (*haystack == *needle && strncmp(haystack, needle, length) == 0) return (char*)haystack;
  }
  return NULL;
}

char* strpbrk(const char* string, const char* accept) {
  for (; *string; string++) {
    if (strchr(accept, *string)) return (char*)string;
  }
  return NULL;
}

size_t strspn(const char* string, const char* accept) {
  size_t length = 0;
  while (string[length] && strchr(accept, string[length])) length++;
  return length;
}

size_t strcspn(const char* string, const char* reject) {
  size_t length = 0;
  while (string[length] && !strchr(reject, string[length])) length++;
  return length;
}

char* strtok(char* restrict string, const char* restrict delimiters) {
  static char* position;
  if (!string) string = position;
  if (!string) return NULL;
  string += strspn(string, delimiters);
  if (!*string) {
    position = NULL;
    return NULL;
  }
  char* token = string;
  string += strcspn(string, delimiters);
  if (*string) {
    *string = '\0';
    position = string + 1;
  } else {
    position = NULL;
  }
  return token;
}

char* strdup(const char* string) {
  size_t size = strlen(string) + 1;
  char* copy = malloc(size);
  if (copy) memcpy(copy, string, size);
  return copy;
}

char* strerror(int error) {
  switch (error) {
    case 0: return "Success";
    case EDOM: return "Numerical argument out of domain";
    case ERANGE: return "Numerical result out of range";
    case ENOENT: return "No such file or directory";
    case EIO: return "Input/output error";
    case EBADF: return "Bad file descriptor";
    case ENOMEM: return "Cannot allocate memory";
    case EACCES: return "Permission denied";
    case EEXIST: return "File exists";
    case EINVAL: return "Invalid argument";
    case EMFILE: return "Too many open files";
    case ENOSYS: return "Function not implemented";
    default: {
      static char message[32];
      console_libc_snprintf(message, sizeof message, "Unknown error %d", error);
      return message;
    }
  }
}
