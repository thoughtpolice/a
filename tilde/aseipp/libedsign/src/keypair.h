// SPDX-FileCopyrightText: © 2024-2025 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/*
** Public/private key generation.
** Copyright (C) 2014 Austin Seipp, Well-Typed LLP.
** See Copyright Notice in edsign.h
**
** Design mostly inspired by signify, written for OpenBSD.
** Copyright (C) 2013 Ted Unangst <tedu@openbsd.org>. See LICENSE.txt
*/

#ifndef _EDSIGN_GENKEY_H_
#define _EDSIGN_GENKEY_H_

#ifdef __cplusplus
extern "C" {
#endif

int
edsign_keypair(const uint8_t* pass, const uint64_t passlen,
               const uint32_t N, const uint32_t r, const uint32_t p,
               uint8_t* pkout, uint8_t* skout);

int
edsign_rekey_priv(const uint8_t* oldpass, const uint64_t oldpasslen,
                  const uint8_t* newpass, const uint64_t newpasslen,
                  const uint32_t N, const uint32_t r, const uint32_t p,
                  uint8_t* skin, uint8_t* skout);

int
edsign_pubkey_fingerprint(const uint8_t* pk, uint8_t* out);

int
edsign_secretkey_fingerprint(const uint8_t* sk, uint8_t* out);

#ifdef __cplusplus
} /* extern "C" */
#endif

#endif /* !_EDSIGN_GENKEY_H_ */
