// SPDX-FileCopyrightText: © 2024-2025 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

#include <stdio.h>
#include <stdlib.h>
#include <stdint.h>
#include <string.h>

#include "libedsign/edsign.h"

int
main(int ac, char** av)
{
  int r = -1;
  uint8_t pk[edsign_PUBLICKEYBYTES];
  uint8_t sk[edsign_SECRETKEYBYTES];
  uint8_t newsk[edsign_SECRETKEYBYTES];

  uint8_t* pass1;
  uint8_t* pass2;
  uint64_t passlen1;
  uint64_t passlen2;

  if (ac < 2) {
    pass1 = NULL;
    passlen1 = 0;
  }
  else {
    pass1 = (uint8_t*)av[1];
    passlen1 = strlen(av[1]);
  }

  if (ac < 3) {
    pass2 = NULL;
    passlen2 = 0;
  }
  else {
    pass2 = (uint8_t*)av[2];
    passlen2 = strlen(av[2]);
  }

  edsign_keypair(pass1, passlen1, 14, 8, 1, pk, sk);
  r = edsign_rekey_priv(pass1, passlen1, pass2, passlen2, 16, 8, 1, sk, newsk);
  printf("result: %s\n", (r == 0) ? "OK" : "FAIL");
  return r;
}
