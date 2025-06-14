// SPDX-FileCopyrightText: © 2024-2025 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/*
** ed25519 signatures.
** Copyright (C) 2014 Austin Seipp, Well-Typed LLP.
** See Copyright Notice in edsign.h
**
** Majority of code taken verbatim from SUPERCOP ed25519 reference
** implementation, released in public domain. See LICENSE.txt.
*/

#ifndef _EDSIGN_ED25519_H_
#define _EDSIGN_ED25519_H_

#define crypto_sign_PUBLICKEYBYTES 32
#define crypto_sign_SECRETKEYBYTES 64
#define crypto_sign_BYTES 64

#define crypto_sign_ed25519_PUBLICKEYBYTES 32
#define crypto_sign_ed25519_SECRETKEYBYTES 64
#define crypto_sign_ed25519_BYTES          64

#define crypto_sign_keypair crypto_sign_ed25519_keypair
#define crypto_sign         crypto_sign_ed25519
#define crypto_sign_open    crypto_sign_ed25519_open

#ifdef __cplusplus
extern "C" {
#endif

EDSIGN_STATIC int
crypto_sign_ed25519_keypair(uint8_t* pk, uint8_t* sk);

EDSIGN_STATIC int
crypto_sign_ed25519(
  uint8_t* sm, uint64_t* smlen,
  const uint8_t* m, uint64_t mlen,
  const uint8_t* sk
            );

EDSIGN_STATIC int
crypto_sign_ed25519_open(
  uint8_t *m, uint64_t *mlen,
  const uint8_t *sm, uint64_t smlen,
  const uint8_t *pk
                 );

#ifdef __cplusplus
} /* extern "C" */
#endif

#endif /* !_EDSIGN_ED25519_H_ */
