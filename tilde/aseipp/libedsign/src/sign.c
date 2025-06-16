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

#include "edsign-private.h"
#include "randombytes.h"
#include "ed25519.h"
#include "scrypt.h"
#include "blake2.h"
#include "keypair.h"
#include "util.h"

#define PKALG "Ed"
#define KDFALG "SK"

/**
 * edsign_sign(pass, passlen, sk, msg, msglen, sig):
 *
 * Sign a message ${msg} with the secret key ${sk} (optionally
 * encrypted using ${pass}) and return the signature ${sig} of the
 * resulting message. ${msg}, ${sk} and ${sig} can not be NULL.
 *
 * The signature ${sig} must be at least edsign_sign_BYTES in size.
 *
 * - Returns EDSIGN_EINVAL if the arguments are invalid
 * - Returns EDSIGN_EPASSWD if the password is invalid
 * - Returns EDSIGN_OK under normal circumstances
 */
int
edsign_sign(const uint8_t* pass, const uint64_t passlen,
            const uint8_t* sk,
            const uint8_t* msg, const uint64_t msglen,
            uint8_t* out)
{
  uint32_t N, r, p;
  uint8_t* pp;
  uint8_t* pout;
  uint8_t* salt;
  uint8_t* digest;
  uint8_t* fp; /* fingerprint */
  uint8_t* enckey;
  uint8_t key[crypto_sign_ed25519_SECRETKEYBYTES];
  uint8_t hash[crypto_hash_blake2b_BYTES];
  uint8_t sig[crypto_hash_blake2b_BYTES + crypto_sign_ed25519_BYTES];
  uint64_t siglen;
  uint64_t i;
  int res = EDSIGN_ERROR;

  /* All arguments must be valid */
  if (msg == NULL) return EDSIGN_EINVAL;
  if (out == NULL) return EDSIGN_EINVAL;
  if (sk  == NULL) return EDSIGN_EINVAL;

  pp = (uint8_t*)sk;

  /* Basics: header verification, decoding parameters */
  if (0 != edsign_memcmp(pp, (uint8_t*)PKALG, 2)) return EDSIGN_EINVAL;
  pp += 2;

  if (0 != edsign_memcmp(pp, (uint8_t*)KDFALG, 2)) return EDSIGN_EINVAL;
  pp += 2;

  /* scrypt parameters */
  N = edsign_le32dec(pp); pp += 4;
  r = edsign_le32dec(pp); pp += 4;
  p = edsign_le32dec(pp); pp += 4;

  /* Key parameters */
  salt   = pp; pp += 16;
  digest = pp; pp += 8;
  fp     = pp; pp += 8;
  enckey = pp;

  /* Derive keystream from passphrase if provided. */
  if (pass != NULL) {
    uint64_t pow2N = ((uint64_t)1) << N;
    res = crypto_scrypt(pass, passlen, salt, 16, pow2N, r, p,
                        key, sizeof(key));
    if (res != 0) {
      res = EDSIGN_EINVAL;
      goto exit;
    }
  }
  else {
    /* If there's no key, zero the keystream buffer. */
    edsign_bzero(key, sizeof(key));
  }

  /* Decrypt secret key (iff password was provided) */
  for (i = 0; i < sizeof(key); ++i) key[i] ^= enckey[i];

  /* Compute and check secret key digest */
  crypto_hash_blake2b(hash, key, sizeof(key));
  if (0 != edsign_memcmp(hash, digest, 8)) {
    res = EDSIGN_EPASSWD;
    goto exit;
  }

  /* Hash the message and sign the hash. */
  crypto_hash_blake2b(hash, msg, msglen);
  /* Note: the first 64 bytes of a signed Ed25519 message constitute
  ** the signature by itself. See memcpy below. */
  crypto_sign_ed25519(sig, &siglen, hash, sizeof(hash), key);
  assert(siglen == sizeof(sig));

  /* Write signature */
  pout = out;
  memcpy(pout, PKALG, 2); pout += 2;
  memcpy(pout, fp, 8);    pout += 8;
  memcpy(pout, sig, 64);

  edsign_bzero(sig, sizeof(sig));
  res = EDSIGN_OK;
 exit:
  edsign_bzero(key, sizeof(key));
  edsign_bzero(hash, sizeof(hash));
  return res;
}

/**
 * edsign_signature_fingerprint(sig, fprint):
 *
 * Get the fingerprint for the signature ${sig} and store it in
 * ${fprint}. ${sig} and ${fprint} can not be NULL.
 *
 * The fingerprint ${fprint} must be at least edsign_fingerprint_BYTES
 * in size.
 *
 * - Returns EDSIGN_EINVAL if the arguments are invalid
 * - Returns EDSIGN_OK under normal circumstances
 */
int
edsign_signature_fingerprint(const uint8_t* sig, uint8_t* out)
{
  if (sig == NULL) return EDSIGN_EINVAL;
  if (out == NULL) return EDSIGN_EINVAL;
  if (0 != edsign_memcmp(sig, (uint8_t*)PKALG, 2)) return EDSIGN_EINVAL;

  memcpy(out,sig+2 , edsign_fingerprint_BYTES);
  return EDSIGN_OK;
}

#undef PKALG
#undef KDFALG
