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

#ifndef _EDSIGN_RANDOMBYTES_H_
#define _EDSIGN_RANDOMBYTES_H_

#ifdef __cplusplus
extern "C" {
#endif

EDSIGN_STATIC void
edsign_randombytes(uint8_t *x, uint64_t xlen);

#ifdef __cplusplus
} /* extern "C" */
#endif

#endif /* !_LIBQUIET_UTIL_RANDOMBYTES_H_ */
