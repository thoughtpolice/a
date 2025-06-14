// SPDX-FileCopyrightText: © 2024-2025 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/* --------------------------------------------------------------- */

#define _GNU_SOURCE

// libc
#include <assert.h>
#include <ctype.h>
#include <stdarg.h>
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>

// glibc
#include <argp.h>
#include <err.h>
#include <errno.h>
#include <fcntl.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <syslog.h>
#include <unistd.h>

// local
#include "util/co.h"

struct cookie {
  int limit;
  int *output;
};

void f(void) {
  int i = 0;
  struct cookie *c = coro_cookie();

  while (i++ < c->limit) {
    coro_yield();
  }

  *c->output = i;
  coro_return(EXIT_SUCCESS);
}

int main(void) {
  int ret = EXIT_FAILURE;

  int out = 0;
  struct cookie c = {
      .limit = 42,
      .output = &out,
  };

  struct coro *co = coro_autonew(4096, &f, &c);
  coro_switch(co);

  do {
    if (coro_done(co))
      break;
    coro_switch(co);
  } while (1);

  printf("coro output = %d\n", out);

  ret = co->ret;
  coro_destroy(&co);

  return EXIT_SUCCESS;
}
