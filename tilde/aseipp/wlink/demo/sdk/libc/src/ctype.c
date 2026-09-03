// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// The C locale over ASCII; bytes above 127 belong to no class.
#include <ctype.h>

int isdigit(int c) {
  return c >= '0' && c <= '9';
}

int isupper(int c) {
  return c >= 'A' && c <= 'Z';
}

int islower(int c) {
  return c >= 'a' && c <= 'z';
}

int isalpha(int c) {
  return isupper(c) || islower(c);
}

int isalnum(int c) {
  return isalpha(c) || isdigit(c);
}

int isxdigit(int c) {
  return isdigit(c) || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F');
}

int isspace(int c) {
  return c == ' ' || (c >= '\t' && c <= '\r');
}

int iscntrl(int c) {
  return (c >= 0 && c < 32) || c == 127;
}

int isprint(int c) {
  return c >= 32 && c < 127;
}

int isgraph(int c) {
  return c > 32 && c < 127;
}

int ispunct(int c) {
  return isgraph(c) && !isalnum(c);
}

int tolower(int c) {
  return isupper(c) ? c + ('a' - 'A') : c;
}

int toupper(int c) {
  return islower(c) ? c - ('a' - 'A') : c;
}
