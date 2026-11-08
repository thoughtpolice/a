// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// A minimal kernel: boot from the appended boot files, run scheme-start.
#include "scheme.h"

#include "chez_embed.h"

#include <stdio.h>

int
main(int argc, const char* argv[])
{
  Sscheme_init(NULL);
  if (chez_embed_register(chez_embed_self_path(argv[0])) < 0) {
    fprintf(stderr, "no boot files appended\n");
    return 70;
  }
  Sbuild_heap(argv[0], NULL);
  int status = Sscheme_start(argc, argv);
  Sscheme_deinit();
  return status;
}
