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
  uint8_t sig[edsign_sign_BYTES];

  uint8_t* pass;
  uint64_t passlen;

  if (ac < 2) {
    pass = NULL;
    passlen = 0;
  }
  else {
    pass = (uint8_t*)av[1];
    passlen = strlen(av[1]);
  }

  uint8_t* msg = (uint8_t*)"Hello world!";

  edsign_keypair(pass, passlen, 14, 8, 1, pk, sk);
  edsign_sign(pass, passlen, sk, msg, 12, sig);
  r = edsign_verify(pk, sig, msg, 12);

  printf("result: %s\n", (r == 0) ? "OK" : "FAIL");
  return r;
}
