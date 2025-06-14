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
 * edsign_keypair(pass, passlen, N, r, p, pk, sk):
 *
 * Generate a public key ${pk} and secret key ${sk}, with the secret
 * key optionally encrypted using the password ${pass}. If ${pass} is
 * not NULL, then the returned secret key is encrypted with
 * scrypt. If ${pass} is NULL, then the secret key is unencrypted.
 *
 * The arguments ${N}, ${r} and ${p} control CPU and memory usage for
 * scrypt, and are only relevant when ${pass} is not NULL. Running
 * time of scrypt is proportional to all of ${N}, ${r} and
 * ${p}. Memory usage of scrypt is approximately 128*${r}*(2^${N})
 * bytes. For example, for N = 14, r = 8, and p = 1, memory usage is
 * 128*8*(2^14) = 16 megabytes. ${p} may be used to independently tune
 * running time.
 *
 * The public key ${pk} must be at least edsign_PUBLICKEYBYTES in size.
 * The secret key ${sk} must be at least edsign_SECRETKEYBYTES in size.
 *
 * - Returns EDSIGN_EINVAL if the arguments are invalid
 * - Returns EDSIGN_OK under normal circumstances
 */
int
edsign_keypair(const uint8_t* pass, const uint64_t passlen,
               const uint32_t N, const uint32_t r, const uint32_t p,
               uint8_t* pkout, uint8_t* skout)
{
  uint8_t pk[crypto_sign_ed25519_PUBLICKEYBYTES];
  uint8_t sk[crypto_sign_ed25519_SECRETKEYBYTES];
  uint8_t digest[crypto_hash_blake2b_BYTES];
  uint8_t fingerprint[8];
  uint8_t salt[16];
  uint8_t* pp;
  uint64_t i;
  int res = EDSIGN_ERROR;

  if (pkout == NULL) return EDSIGN_EINVAL;
  if (skout == NULL) return EDSIGN_EINVAL;

  edsign_randombytes(salt, sizeof(salt));
  edsign_randombytes(fingerprint, sizeof(fingerprint));
  crypto_sign_ed25519_keypair(pk, sk);
  crypto_hash_blake2b(digest, sk, sizeof(sk)); /* Key digest */

  /* -- Public key -- */
  pp = pkout;
  memcpy(pp, PKALG, 2); pp += 2;
  memcpy(pp, fingerprint, sizeof(fingerprint)); pp += sizeof(fingerprint);
  memcpy(pp, pk, crypto_sign_ed25519_PUBLICKEYBYTES);

  /* -- Secret key -- */
  pp = skout;
  memcpy(pp, PKALG, 2);  pp += 2;
  memcpy(pp, KDFALG, 2); pp += 2;
  /* Note: encode zeroes if we have no password */
  edsign_le32enc(pp, (pass == NULL) ? 0 : N); pp += 4;
  edsign_le32enc(pp, (pass == NULL) ? 0 : r); pp += 4;
  edsign_le32enc(pp, (pass == NULL) ? 0 : p); pp += 4;
  memcpy(pp, salt, sizeof(salt)); pp += sizeof(salt);
  memcpy(pp, digest, 8); pp += 8;
  memcpy(pp, fingerprint, sizeof(fingerprint)); pp += sizeof(fingerprint);

  edsign_bzero(digest, sizeof(digest));

  /* Users can optionally specify a password. */
  if (pass != NULL) {
    uint64_t pow2N = ((uint64_t)1) << N;
    res = crypto_scrypt(pass, passlen, salt, sizeof(salt), pow2N, r, p,
                        pp, crypto_sign_ed25519_SECRETKEYBYTES);
    /* We need to carefully clear key material and *then* bail */
    if (res != 0) {
      res = EDSIGN_EINVAL;
      edsign_bzero(pkout, edsign_PUBLICKEYBYTES);
      edsign_bzero(skout, edsign_SECRETKEYBYTES);
      goto exit;
    }
  }
  else {
    edsign_bzero(pp, crypto_sign_ed25519_SECRETKEYBYTES);
  }

  /* Emit key material, then finish */
  for (i = 0; i < sizeof(sk); ++i) pp[i] ^= sk[i];
  res = EDSIGN_OK;
 exit:
  edsign_bzero(sk, sizeof(sk));
  return res;
}

/**
 * edsign_rekey_priv(oldpass, oldpasslen, newpass, newpasslen, N, r, p, so, sn):
 *
 * Rekey the private key ${so} with the old password ${oldpass},
 * under the new password ${newpass}, with the new scrypt parameters
 * ${N}, ${r}, and ${p}, and store it in ${sn}. ${so} and ${sn} can
 * not be NULL.
 *
 * If ${oldpass} is NULL, it is assumed there was no prior
 * password. If ${newpass} is NULL, the password is removed, and ${N},
 * ${r}, and ${p} are ignored.
 *
 * The secret key ${sn} must be at least edsign_SECRETKEYBYTES in size.
 *
 * - Returns EDSIGN_EINVAL if the arguments are invalid
 * - Returns EDSIGN_EPASSWD if the password is invalid
 * - Returns EDSIGN_OK under normal circumstances
 */
int
edsign_rekey_priv(const uint8_t* oldpass, const uint64_t oldpasslen,
                  const uint8_t* newpass, const uint64_t newpasslen,
                  const uint32_t N, const uint32_t r, const uint32_t p,
                  uint8_t* skin, uint8_t* skout)
{
  uint32_t Nold, rold, pold;
  uint8_t* pp;
  uint8_t* salt;
  uint8_t* digest;
  uint8_t* fp; /* fingerprint */
  uint8_t* enckey;
  uint8_t key[crypto_sign_ed25519_SECRETKEYBYTES];
  uint8_t hash[crypto_hash_blake2b_BYTES];
  uint8_t newsalt[16];
  uint64_t i;
  int res = EDSIGN_ERROR;

  if (skin == NULL)  return EDSIGN_EINVAL;
  if (skout == NULL) return EDSIGN_EINVAL;

  edsign_randombytes(newsalt, 16);
  pp = (uint8_t*)skin;

  /* Basics: verification, decoding parameters */
  if (0 != edsign_memcmp(pp, (uint8_t*)PKALG, 2)) return EDSIGN_EINVAL;
  pp += 2;

  if (0 != edsign_memcmp(pp, (uint8_t*)KDFALG, 2)) return EDSIGN_EINVAL;
  pp += 2;

  Nold = edsign_le32dec(pp); pp += 4;
  rold = edsign_le32dec(pp); pp += 4;
  pold = edsign_le32dec(pp); pp += 4;

  salt   = pp; pp += 16;
  digest = pp; pp += 8;
  fp     = pp; pp += 8;
  enckey = pp;

  /* Iff there are no scrypt parameters, then there was no. Rekey. */
  if (Nold == 0 || rold == 0 || pold == 0) {
    edsign_bzero(key, sizeof(key));
    goto rekey;
  }

  /* Derive key */
  if (oldpass != NULL) {
    uint64_t pow2N = ((uint64_t)1) << Nold;
    res = crypto_scrypt(oldpass, oldpasslen, salt, 16, pow2N, rold, pold,
                        key, sizeof(key));
    if (res != 0) {
      res = EDSIGN_EINVAL;
      goto exit;
    }
  }
  else {
    edsign_bzero(key, sizeof(key));
  }

 rekey:
  /* First, validate the key */
  for (i = 0; i < sizeof(key); ++i) key[i] ^= enckey[i];
  crypto_hash_blake2b(hash, key, sizeof(key));

  if (0 != edsign_memcmp(hash, digest, 8)) {
    res = EDSIGN_EPASSWD;
    goto exit;
  }

  /* Rekey based on given inputs */
  pp = (uint8_t*)skout;

  memcpy(pp, PKALG, 2);  pp += 2;
  memcpy(pp, KDFALG, 2); pp += 2;
  /* Note: encode zeroes if we have no password */
  edsign_le32enc(pp, (newpass == NULL) ? 0 : N); pp += 4;
  edsign_le32enc(pp, (newpass == NULL) ? 0 : r); pp += 4;
  edsign_le32enc(pp, (newpass == NULL) ? 0 : p); pp += 4;
  memcpy(pp, newsalt, sizeof(newsalt)); pp += sizeof(newsalt);
  memcpy(pp, hash, 8); pp += 8;
  memcpy(pp, fp, 8); pp += 8;

  /* Users can optionally specify a password. */
  if (newpass != NULL) {
    uint64_t pow2N = ((uint64_t)1) << N;
    res = crypto_scrypt(newpass, newpasslen, newsalt, sizeof(newsalt),
                        pow2N, r, p, pp, crypto_sign_ed25519_SECRETKEYBYTES);
    if (res != 0) {
      res = EDSIGN_EINVAL;
      goto exit;
    }
  }
  else {
    edsign_bzero(pp, crypto_sign_ed25519_SECRETKEYBYTES);
  }

  /* Emit key material, then finish */
  for (i = 0; i < crypto_sign_ed25519_SECRETKEYBYTES; ++i)
    pp[i] ^= key[i];

  res = EDSIGN_OK;
 exit:
  edsign_bzero(key, sizeof(key));
  edsign_bzero(hash, sizeof(hash));
  return res;
}

/**
 * edsign_pubkey_fingerprint(pk, fprint):
 *
 * Get the fingerprint for the public key ${pk} and store it in
 * ${fprint}. ${pk} and ${fprint} can not be NULL.
 *
 * The fingerprint ${fprint} must be at least edsign_fingerprint_BYTES
 * in size.
 *
 * - Returns EDSIGN_EINVAL if the arguments are invalid
 * - Returns EDSIGN_OK under normal circumstances
 */
int
edsign_pubkey_fingerprint(const uint8_t* pk, uint8_t* out)
{
  if (pk  == NULL) return EDSIGN_EINVAL;
  if (out == NULL) return EDSIGN_EINVAL;
  if (0 != edsign_memcmp(pk, (uint8_t*)PKALG, 2)) return EDSIGN_EINVAL;

  memcpy(out, pk+2, edsign_fingerprint_BYTES);
  return EDSIGN_OK;
}

/**
 * edsign_secretkey_fingerprint(sk, fprint):
 *
 * Get the fingerprint for the secret key ${sk} and store it in
 * ${fprint}. ${sk} and ${fprint} can not be NULL.
 *
 * The fingerprint ${fprint} must be at least edsign_fingerprint_BYTES
 * in size.
 *
 * - Returns EDSIGN_EINVAL if the arguments are invalid
 * - Returns EDSIGN_OK under normal circumstances
 */
int
edsign_secretkey_fingerprint(const uint8_t* sk, uint8_t* out)
{
  if (sk  == NULL) return EDSIGN_EINVAL;
  if (out == NULL) return EDSIGN_EINVAL;
  if (0 != edsign_memcmp(sk,   (uint8_t*)PKALG, 2))  return EDSIGN_EINVAL;
  if (0 != edsign_memcmp(sk+2, (uint8_t*)KDFALG, 2)) return EDSIGN_EINVAL;

  memcpy(out, sk+40, edsign_fingerprint_BYTES);
  return EDSIGN_OK;
}

#undef PKALG
#undef KDFALG
