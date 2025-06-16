// SPDX-FileCopyrightText: © 2024-2025 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/*
** libedsign -- tiny library for signature verification
**
** Copyright (C) 2014 Austin Seipp, Well-Typed LLP. All rights reserved.
**
** Permission is hereby granted, free of charge, to any person obtaining
** a copy of this software and associated documentation files (the
** "Software"), to deal in the Software without restriction, including
** without limitation the rights to use, copy, modify, merge, publish,
** distribute, sublicense, and/or sell copies of the Software, and to
** permit persons to whom the Software is furnished to do so, subject to
** the following conditions:
**
** The above copyright notice and this permission notice shall be
** included in all copies or substantial portions of the Software.
**
** THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
** EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
** MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
** IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY
** CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT,
** TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE
** SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
**
** [ MIT license: http://www.opensource.org/licenses/mit-license.php ]
**
** [ edsign includes code from scrypt, which has this license statement: ]
**
** Copyright 2009 Colin Percival
** All rights reserved.
**
** Redistribution and use in source and binary forms, with or without
** modification, are permitted provided that the following conditions are
** met:
** 1. Redistributions of source code must retain the above copyright
**    notice, this list of conditions and the following disclaimer.
** 2. Redistributions in binary form must reproduce the above copyright
**    notice, this list of conditions and the following disclaimer in the
**    documentation and/or other materials provided with the
**    distribution.
**
** THIS SOFTWARE IS PROVIDED BY THE AUTHOR AND CONTRIBUTORS ``AS IS'' AND
** ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
** IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR
** PURPOSE ARE DISCLAIMED.  IN NO EVENT SHALL THE AUTHOR OR CONTRIBUTORS
** BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR
** CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF
** SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR
** BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY,
** WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE
** OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN
** IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
**
** [ edsign includes code from BLAKE2, which has this license statement: ]
**
** Written in 2012 by Samuel Neves <sneves@dei.uc.pt>
**
** To the extent possible under law, the author(s) have dedicated all
** copyright and related and neighboring rights to this software to the
** public domain worldwide. This software is distributed without any
** warranty.
**
** You should have received a copy of the CC0 Public Domain Dedication
** along with this software. If not, see
** <http://creativecommons.org/publicdomain/zero/1.0/>.
**
** [ edsign takes inspiration from signify, which has this license statement: ]
**
** Copyright (c) 2013 Ted Unangst <tedu@openbsd.org>
**
** Permission to use, copy, modify, and distribute this software for any
** purpose with or without fee is hereby granted, provided that the above
** copyright notice and this permission notice appear in all copies.
**
** THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL
** WARRANTIES WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED
** WARRANTIES OF MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE
** AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL
** DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR
** PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER
** TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR
** PERFORMANCE OF THIS SOFTWARE.
**
** [ edsign includes code from SUPERCOP, which has this license statement: ]
**
** Public Domain.
**
** Authors: Daniel J. Bernstein, Niels Duif, Tanja Lange, Peter Schwabe,
** Bo-Yin Yang
*/

#ifndef _LIBEDSIGN_H_
#define _LIBEDSIGN_H_

#ifdef __cplusplus
extern "C" {
#endif

/* -------------------------------------------------------------------------- */
/* -- Return codes ---------------------------------------------------------- */

#define EDSIGN_OK      0 /* Successful result */
/* -- Error codes below -- */
#define EDSIGN_ERROR   1 /* Internal/unknown error */
#define EDSIGN_EINVAL  2 /* Invalid argument */
#define EDSIGN_EPASSWD 3 /* Invalid password */
#define EDSIGN_EKEY    4 /* Wrong public key */
#define EDSIGN_ESIG    5 /* Signature verification failure */

/* -------------------------------------------------------------------------- */
/* -- Public API ------------------------------------------------------------ */

#define edsign_PUBLICKEYBYTES 42
#define edsign_SECRETKEYBYTES 112
#define edsign_sign_BYTES 74
#define edsign_fingerprint_BYTES 8

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
int edsign_keypair(const uint8_t* pass, const uint64_t passlen,
                   const uint32_t N, const uint32_t r, const uint32_t p,
                   uint8_t* pkout, uint8_t* skout);

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
int edsign_rekey_priv(const uint8_t* oldpass, const uint64_t oldpasslen,
                      const uint8_t* newpass, const uint64_t newpasslen,
                      const uint32_t N, const uint32_t r, const uint32_t p,
                      uint8_t* so, uint8_t* sn);

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
int edsign_sign(const uint8_t* pass, const uint64_t passlen,
                const uint8_t* sk,
                const uint8_t* msg, const uint64_t msglen,
                uint8_t* sig);

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
int edsign_verify(const uint8_t* pk, const uint8_t *sig,
                  const uint8_t* msg,  const uint64_t msglen);

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
int edsign_pubkey_fingerprint(const uint8_t* pk, uint8_t* out);

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
int edsign_secretkey_fingerprint(const uint8_t* sk, uint8_t* out);

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
int edsign_signature_fingerprint(const uint8_t* sig, uint8_t* out);

#ifdef __cplusplus
} /* extern "C" */
#endif

#endif /* !_LIBEDSIGN_H_ */
