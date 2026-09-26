/* SPDX-FileCopyrightText: 2026 Austin Seipp
 * SPDX-License-Identifier: Apache-2.0 */
#ifndef BISON_NATIVE_DECLARATIONS_H
#define BISON_NATIVE_DECLARATIONS_H
#include "config.h"
#include <stdarg.h>

/* Gnulib supplies these extensions; musl's stdio.h does not declare them. */
struct obstack;
int obstack_printf(struct obstack *, const char *, ...);
int obstack_vprintf(struct obstack *, const char *, va_list);
#endif
