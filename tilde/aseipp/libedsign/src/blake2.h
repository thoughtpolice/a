// SPDX-FileCopyrightText: © 2024-2025 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/*
** BLAKE2b hash function.
** Copyright (C) 2014 Austin Seipp, Well-Typed LLP.
** See Copyright Notice in edsign.h
**
** Majority of code taken verbatim from BLAKE2 reference code,
** released in the public domain. See LICENSE.txt
*/

#ifndef _EDSIGN_BLAKE2_H_
#define _EDSIGN_BLAKE2_H_

#ifdef __cplusplus
extern "C" {
#endif

#define crypto_hash_BYTES 64
#define crypto_hash_blake2b_BYTES 64
#define crypto_hash crypto_hash_blake2b

EDSIGN_STATIC int
crypto_hash_blake2b(uint8_t* out, const uint8_t* in, uint64_t inlen);

#ifdef __cplusplus
} /* extern "C" */
#endif

#endif /* !_EDSIGN_BLAKE2_H_ */
