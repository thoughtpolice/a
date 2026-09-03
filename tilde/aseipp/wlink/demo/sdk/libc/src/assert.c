// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

#include <assert.h>
#include <stdio.h>
#include <stdlib.h>

_Noreturn void __console_assert_fail(const char* expression, const char* file, int line,
                                     const char* function) {
  fprintf(stderr, "%s:%d: %s: assertion `%s' failed\n", file, line, function, expression);
  fflush(stderr);
  abort();
}
