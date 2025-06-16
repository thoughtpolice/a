// SPDX-FileCopyrightText: © 2024-2025 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/*
** Utility functions.
** Copyright (C) 2014 Austin Seipp, Well-Typed LLP.
** See Copyright Notice in edsign.h
*/

#ifndef _EDSIGN_UTIL_H_
#define _EDSIGN_UTIL_H_

#ifdef __cplusplus
extern "C" {
#endif

EDSIGN_STATIC int
edsign_memcmp(const uint8_t* x, const uint8_t* y, const size_t n);

EDSIGN_STATIC int
edsign_bzero(uint8_t* dst, const size_t n);

EDSIGN_STATIC uint32_t
edsign_le32dec(const void *pp);

EDSIGN_STATIC void
edsign_le32enc(void *pp, uint32_t x);

#ifdef __cplusplus
} /* extern "C" */
#endif

#endif /* !_EDSIGN_UTIL_H_ */
