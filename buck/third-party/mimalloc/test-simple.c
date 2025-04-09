// SPDX-FileCopyrightText: © 2024-2025 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

#include <stdio.h>

#include "mimalloc.h"

int
main(void) {
  int* i = mi_malloc(sizeof(int));
  *i = 42;
  printf("i = %d\n", *i);
  mi_free(i);
  return 0;
}
