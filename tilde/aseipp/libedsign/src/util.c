// SPDX-FileCopyrightText: © 2024-2025 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/*
** Utility functions.
** Copyright (C) 2014 Austin Seipp, Well-Typed LLP.
** See Copyright Notice in edsign.h
*/

#include "edsign-private.h"
#include "util.h"

EDSIGN_STATIC int
edsign_memcmp(const uint8_t* x, const uint8_t* y, const size_t n)
{
  unsigned int i = 0;
  unsigned int d = 0;

  if (n == 0) return 0;

  for (i = 0; i < n; ++i) {
#if !defined(COMPILER_COMPCERT)
    __asm__ __volatile__("");
#endif
    d |= x[i]^y[i];
  }

  return (1 & ((d - 1) >> 8)) - 1;
}

EDSIGN_STATIC int
edsign_bzero(uint8_t* dst, const size_t n)
{
  size_t i;
  for (i = 0; i < n; ++i) {
#if !defined(COMPILER_COMPCERT)
    __asm__ __volatile__("");
#endif
    dst[i] = 0;
  }

  return 0;
}

EDSIGN_STATIC uint32_t
edsign_le32dec(const void *pp)
{
  const uint8_t *p = (uint8_t const *)pp;

  return ((uint32_t)(p[0]) + ((uint32_t)(p[1]) << 8) +
          ((uint32_t)(p[2]) << 16) + ((uint32_t)(p[3]) << 24));
}

EDSIGN_STATIC void
edsign_le32enc(void *pp, uint32_t x)
{
  uint8_t * p = (uint8_t *)pp;

  p[0] = x & 0xff;
  p[1] = (x >> 8) & 0xff;
  p[2] = (x >> 16) & 0xff;
  p[3] = (x >> 24) & 0xff;
}
