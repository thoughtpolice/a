// SPDX-FileCopyrightText: © 2024-2025 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/* --------------------------------------------------------------- */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <termios.h>
#include <unistd.h>

#include "util/password.h"

/* --------------------------------------------------------------- */

char*
get_password(void)
{
  char *pass, *nl;
  size_t blen;
  ssize_t pass_len;
  struct termios ti;

  tcgetattr(STDIN_FILENO, &ti);
  ti.c_lflag &= ~ECHO;
  tcsetattr(STDIN_FILENO, TCSANOW, &ti);

  pass_len = getdelim(&pass, &blen, '\n', stdin);
  if (pass_len < 0) {
    free(pass);
    return NULL;
  }

  ti.c_lflag |= ECHO;
  tcsetattr(STDIN_FILENO, TCSANOW, &ti);
  nl = strchr(pass, '\n');
  if (nl) {
    *nl = '\0';
  }

  return 0;
}

/* --------------------------------------------------------------- */
