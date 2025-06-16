// SPDX-FileCopyrightText: © 2024-2025 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/*
** Signature generation.
** Copyright (C) 2014 Austin Seipp, Well-Typed LLP.
** See Copyright Notice in edsign.h
**
** Design mostly inspired by signify, written for OpenBSD.
** Copyright (C) 2013 Ted Unangst <tedu@openbsd.org>. See LICENSE.txt
*/

#ifndef _EDSIGN_SIGN_H_
#define _EDSIGN_SIGN_H_

#ifdef __cplusplus
extern "C" {
#endif

int edsign_sign(const uint8_t* pass, const uint64_t passlen,
                const uint8_t* sk,
                const uint8_t* msg, const uint64_t msglen,
                uint8_t* out);

int
edsign_signature_fingerprint(const uint8_t* sig, uint8_t* out);

#ifdef __cplusplus
} /* extern "C" */
#endif

#endif /* !_EDSIGN_SIGN_H_ */
