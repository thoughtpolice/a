// SPDX-FileCopyrightText: © 2024-2025 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/* --------------------------------------------------------------- */

#include <stdint.h>
#include <stdlib.h>
#include <err.h>

#include <sys/types.h>
#include <sys/stat.h>
#include <unistd.h>

#include "util/file_size.h"

/* --------------------------------------------------------------- */

void
file_size(int fd, off_t* size)
{
  struct stat st;
  if (fstat(fd, &st) < 0)
    err(EXIT_FAILURE, "fstat");

  if (S_ISREG(st.st_mode)) {
    *size = st.st_size;
    return;
  }

  errx(EXIT_FAILURE, "file_size");
}

/* --------------------------------------------------------------- */
