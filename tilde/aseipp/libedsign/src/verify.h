// SPDX-FileCopyrightText: © 2024-2025 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/*
** Signature verification.
** Copyright (C) 2014 Austin Seipp, Well-Typed LLP.
** See Copyright Notice in edsign.h
**
** Design mostly inspired by signify, written for OpenBSD.
** Copyright (C) 2013 Ted Unangst <tedu@openbsd.org>. See LICENSE.txt
*/

#ifndef _EDSIGN_VERIFY_H_
#define _EDSIGN_VERIFY_H_

#ifdef __cplusplus
extern "C" {
#endif

int edsign_verify(const uint8_t* pk, const uint8_t *sig,
                  const uint8_t* msg,  const uint64_t msglen);

#ifdef __cplusplus
} /* extern "C" */
#endif

#endif /* !_EDSIGN_VERIFY_H_ */
