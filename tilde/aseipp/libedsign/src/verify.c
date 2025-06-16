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

#include "edsign-private.h"
#include "blake2.h"
#include "ed25519.h"
#include "sign.h"
#include "util.h"

#define PKALG "Ed"

/**
 * edsign_verify(pk, sig, msg, msglen):
 *
 * Verify the message ${msg} (of size ${msglen}) with signature ${sig}
 * was signed by the public key ${pk}. ${msg}, ${pk} and ${sig} can
 * not be NULL.
 *
 * - Returns EDSIGN_EINVAL if the arguments are invalid
 * - Returns EDSIGN_EKEY if ${pk} is an incorrect public key for the signature
 * - Returns EDSIGN_ESIG if the ${sig} and ${msg} failed to verify
 * - Returns EDSIGN_OK under normal circumstances
 */
int
edsign_verify(const uint8_t* pk, const uint8_t *sig,
              const uint8_t* msg,  const uint64_t msglen)
{
  int res = EDSIGN_ERROR;
  uint64_t tlen;
  uint8_t hash[crypto_hash_blake2b_BYTES];
  uint8_t smsg[crypto_hash_blake2b_BYTES + crypto_sign_ed25519_BYTES];
  uint8_t out[crypto_hash_blake2b_BYTES + crypto_sign_ed25519_BYTES];

  if (pk  == NULL) return EDSIGN_EINVAL;
  if (sig == NULL) return EDSIGN_EINVAL;
  if (msg == NULL) return EDSIGN_EINVAL;

  if (0 != edsign_memcmp(pk, (uint8_t*)PKALG, 2)) return EDSIGN_EINVAL;
  if (0 != edsign_memcmp(sig, (uint8_t*)PKALG, 2)) return EDSIGN_EINVAL;
  if (0 != edsign_memcmp(pk+2, sig+2, 8)) return EDSIGN_EKEY;

  /* Create ed25519 message */
  crypto_hash_blake2b(hash, msg, msglen); /* Hash message */
  memcpy(smsg,    sig+10, 64);            /* Copy signature */
  memcpy(smsg+64, hash, sizeof(hash));    /* Copy hash */

  /* Verify signature */
  res = crypto_sign_open(out, &tlen, smsg, sizeof(smsg), pk+10);
  assert(tlen == crypto_hash_blake2b_BYTES);
  if (res != 0) res = EDSIGN_ESIG; /* Signature failure */
  return res;
}

#undef PKALG
