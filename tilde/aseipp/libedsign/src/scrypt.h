// SPDX-FileCopyrightText: © 2024-2025 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/*
** scrypt key derivation function.
** Copyright (C) 2014 Austin Seipp, Well-Typed LLP.
** See Copyright Notice in edsign.h
**
** Majority of code taken verbatim from scrypt 1.1.6 source code.
** Copyright (C) 2009 Colin Percival. See LICENSE.txt
*/

#ifndef _EDSIGN_SCRYPT_H_
#define _EDSIGN_SCRYPT_H_

#ifdef __cplusplus
extern "C" {
#endif

/**
 * crypto_scrypt(passwd, passwdlen, salt, saltlen, N, r, p, buf, buflen):
 * Compute scrypt(passwd[0 .. passwdlen - 1], salt[0 .. saltlen - 1], N, r,
 * p, buflen) and write the result into buf.  The parameters r, p, and buflen
 * must satisfy r * p < 2^30 and buflen <= (2^32 - 1) * 32.  The parameter N
 * must be a power of 2 greater than 1.
 *
 * Return 0 on success; or -1 on error.
 */
EDSIGN_STATIC int
crypto_scrypt(const uint8_t *, size_t, const uint8_t *, size_t, uint64_t,
    uint32_t, uint32_t, uint8_t *, size_t);

#ifdef __cplusplus
} /* extern "C" */
#endif

#endif /* !_EDSIGN_SCRYPT_H_ */
