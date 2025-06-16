// SPDX-FileCopyrightText: © 2024-2025 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/*
** Secure generation of random values.
** Copyright (C) 2014 Austin Seipp, Well-Typed LLP.
** See Copyright Notice in edsign.h
**
** Majority of code taken verbatim from SUPERCOP randombytes reference
** implementation, released in public domain. See LICENSE.txt.
*/

#include "edsign-private.h"
#include "randombytes.h"

#if defined(_WIN32) || defined(_WIN64) || defined(__TOS_WIN__) || defined(__WINDOWS__)

EDSIGN_STATIC void
edsign_randombytes(uint8_t *x, uint64_t xlen)
{
  HCRYPTPROV prov = 0;

  if (xlen == 0) return;
  if (x == NULL) return;

  CryptAcquireContextW(&prov, NULL, NULL,
    PROV_RSA_FULL, CRYPT_VERIFYCONTEXT | CRYPT_SILENT);

  CryptGenRandom(prov, xlen, x);
  CryptReleaseContext(prov, 0);
}

#else
static int edsign_randomfd = -1;
EDSIGN_STATIC void
edsign_randombytes(uint8_t *x, uint64_t xlen)
{
  int i;
  if (xlen == 0) return;
  if (x == NULL) return;

  if (edsign_randomfd == -1) {
    for (;;) {
      edsign_randomfd = open("/dev/urandom",O_RDONLY);
      if (edsign_randomfd != -1) break;
      sleep(1);
    }
  }

  while (xlen > 0) {
    if (xlen < 1048576) i = xlen; else i = 1048576;

    i = read(edsign_randomfd,x,i);
    if (i < 1) {
      sleep(1);
      continue;
    }

    x += i;
    xlen -= i;
  }
}
#endif /* !OS_WINDOWS */
