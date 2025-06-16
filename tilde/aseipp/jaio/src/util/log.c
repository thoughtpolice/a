// SPDX-FileCopyrightText: © 2024-2025 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

#include <ctype.h>
#include <stdio.h>
#include <stdarg.h>
#include <stdlib.h>
#include <string.h>

#include <syslog.h>

#include "util/log.h"

/* --------------------------------------------------------------- */

int g_log_prio = LOG_ERR;

void
init_log(char* level)
{
  char* eprio = getenv("AGP_LOG");
  if (eprio != NULL) level = eprio; // environment over args

  char *endptr;
  int prio = strtol(level, &endptr, 10);
  if (endptr[0] == '\0' || isspace(endptr[0])) g_log_prio = prio;
  if (strncmp(level, "err", 3) == 0) g_log_prio = LOG_ERR;
  if (strncmp(level, "info", 4) == 0) g_log_prio = LOG_INFO;
  if (strncmp(level, "debug", 5) == 0) g_log_prio = LOG_DEBUG;
}

void __attribute__((format(printf, 5, 6)))
log_stderr(int priority,
           const char *file, int line, const char *fn,
           const char *format, ...)
{
  va_list args;

  (void)priority;

  va_start(args, format);
  fprintf(stderr, "testing[%s:%d]: %s: ", file, line, fn);
  vfprintf(stderr, format, args);
  va_end(args);

  fflush(stderr);
}

