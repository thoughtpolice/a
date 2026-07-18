// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! HMAC and the HKDF adapter used by rustls's TLS 1.3 key schedule.
//!
//! The `openssl` crate exposes no HMAC interface at all when built against
//! BoringSSL (`PKey::hmac` is OpenSSL-only, and BoringSSL's own HMAC_* API
//! is not bound), so this is the RFC 2104 construction over our SHA-2
//! implementations. BoringSSL still does all the actual hashing.
//!
//! We implement HKDF locally instead of using rustls's `HkdfUsingHmac`:
//! that generic adapter materializes each extracted PRK in an ordinary
//! `Vec<u8>`. Keeping the PRK in rustls's cleansing `hmac::Tag` until it has
//! been folded into [`HmacKey`] avoids leaving a key-equivalent heap copy.
//!
//! The keys handled here are TLS 1.3 key schedule secrets (HKDF PRKs and
//! their derivations), so temporary buffers owned by this module that hold
//! key-equivalent material are cleansed before they are freed.
//!
//! Digest operations `expect` success: BoringSSL digest calls fail only on
//! allocation failure, and the rustls `hmac::Key` trait has no error path,
//! so panicking mirrors the upstream `ring` provider's behaviour.

use std::ops::DerefMut;

use openssl::hash::Hasher;
use rustls::crypto::{hmac, tls13};

use crate::hash::HashKind;

pub(crate) static SHA256: Hmac = Hmac(HashKind::Sha256);
pub(crate) static SHA384: Hmac = Hmac(HashKind::Sha384);
pub(crate) static HKDF_SHA256: Hkdf = Hkdf(&SHA256);
pub(crate) static HKDF_SHA384: Hkdf = Hkdf(&SHA384);

pub(crate) struct Hmac(HashKind);

impl hmac::Hmac for Hmac {
    fn with_key(&self, key: &[u8]) -> Box<dyn hmac::Key> {
        Box::new(HmacKey::new(self.0, key))
    }

    fn hash_output_len(&self) -> usize {
        self.0.output_len()
    }
}

/// A byte buffer that is securely zeroed even when its owner is unwound.
struct Cleansing<T: DerefMut<Target = [u8]>>(T);

impl<T: DerefMut<Target = [u8]>> Cleansing<T> {
    fn new(bytes: T) -> Self {
        Self(bytes)
    }

    fn as_slice(&self) -> &[u8] {
        &self.0
    }

    fn as_mut_slice(&mut self) -> &mut [u8] {
        &mut self.0
    }
}

impl<T: DerefMut<Target = [u8]>> Drop for Cleansing<T> {
    fn drop(&mut self) {
        crate::cleanse(&mut self.0);
    }
}

struct HmacKey {
    kind: HashKind,
    ipad: Cleansing<Vec<u8>>,
    opad: Cleansing<Vec<u8>>,
}

impl HmacKey {
    fn new(kind: HashKind, key: &[u8]) -> Self {
        let block_len = kind.block_len();
        let mut normalized = Cleansing::new(vec![0u8; block_len]);
        if key.len() > block_len {
            let digest = Cleansing::new(
                openssl::hash::hash(kind.digest(), key).expect("BoringSSL hash failed"),
            );
            normalized.as_mut_slice()[..digest.as_slice().len()].copy_from_slice(digest.as_slice());
        } else {
            normalized.as_mut_slice()[..key.len()].copy_from_slice(key);
        }

        let ipad = Cleansing::new(normalized.as_slice().iter().map(|b| b ^ 0x36).collect());
        let opad = Cleansing::new(normalized.as_slice().iter().map(|b| b ^ 0x5c).collect());
        Self { kind, ipad, opad }
    }
}

impl hmac::Key for HmacKey {
    fn sign_concat(&self, first: &[u8], middle: &[&[u8]], last: &[u8]) -> hmac::Tag {
        let mut inner = Hasher::new(self.kind.digest()).expect("BoringSSL digest ctx failed");
        inner
            .update(self.ipad.as_slice())
            .expect("hash update failed");
        inner.update(first).expect("hash update failed");
        for chunk in middle {
            inner.update(chunk).expect("hash update failed");
        }
        inner.update(last).expect("hash update failed");
        let inner_digest = Cleansing::new(inner.finish().expect("hash finish failed"));

        let mut outer = Hasher::new(self.kind.digest()).expect("BoringSSL digest ctx failed");
        outer
            .update(self.opad.as_slice())
            .expect("hash update failed");
        outer
            .update(inner_digest.as_slice())
            .expect("hash update failed");
        let tag = Cleansing::new(outer.finish().expect("hash finish failed"));
        hmac::Tag::new(tag.as_slice())
    }

    fn tag_len(&self) -> usize {
        self.kind.output_len()
    }
}

/// HKDF over the matching SHA-2 HMAC implementation.
///
/// This is deliberately separate from rustls's `HkdfUsingHmac`, whose extract
/// path returns a plain `Vec<u8>` containing the PRK before constructing the
/// expander. Here the PRK remains in a zeroizing [`hmac::Tag`].
pub(crate) struct Hkdf(&'static dyn hmac::Hmac);

impl Hkdf {
    fn extract(&self, salt: Option<&[u8]>, secret: &[u8]) -> HkdfExpander {
        let zero_salt = [0u8; hmac::Tag::MAX_LEN];
        let salt = salt.unwrap_or(&zero_salt[..self.0.hash_output_len()]);
        let salt_key = self.0.with_key(salt);

        // `Tag` zeroizes its backing array on drop. `HmacKey::new` copies the
        // PRK directly into cleansing normalized/ipad/opad buffers, so no
        // uncleansed heap allocation ever contains a standalone PRK.
        let prk = salt_key.sign(&[secret]);
        let key = self.0.with_key(prk.as_ref());
        drop(prk);
        drop(salt_key);
        HkdfExpander { key }
    }
}

impl tls13::Hkdf for Hkdf {
    fn extract_from_zero_ikm(&self, salt: Option<&[u8]>) -> Box<dyn tls13::HkdfExpander> {
        let zero_ikm = [0u8; hmac::Tag::MAX_LEN];
        Box::new(self.extract(salt, &zero_ikm[..self.0.hash_output_len()]))
    }

    fn extract_from_secret(
        &self,
        salt: Option<&[u8]>,
        secret: &[u8],
    ) -> Box<dyn tls13::HkdfExpander> {
        Box::new(self.extract(salt, secret))
    }

    fn expander_for_okm(&self, okm: &tls13::OkmBlock) -> Box<dyn tls13::HkdfExpander> {
        Box::new(HkdfExpander {
            key: self.0.with_key(okm.as_ref()),
        })
    }

    fn hmac_sign(&self, key: &tls13::OkmBlock, message: &[u8]) -> hmac::Tag {
        self.0.with_key(key.as_ref()).sign(&[message])
    }
}

struct HkdfExpander {
    key: Box<dyn hmac::Key>,
}

impl HkdfExpander {
    fn expand_unchecked(&self, info: &[&[u8]], output: &mut [u8]) {
        // Each assignment drops and zeroizes the preceding term. The final
        // term is likewise zeroized when this function returns or unwinds.
        let mut term = hmac::Tag::new(b"");
        for (index, chunk) in output.chunks_mut(self.key.tag_len()).enumerate() {
            term = self
                .key
                .sign_concat(term.as_ref(), info, &[(index + 1) as u8]);
            chunk.copy_from_slice(&term.as_ref()[..chunk.len()]);
        }
    }
}

impl tls13::HkdfExpander for HkdfExpander {
    fn expand_slice(
        &self,
        info: &[&[u8]],
        output: &mut [u8],
    ) -> Result<(), tls13::OutputLengthError> {
        if output.len() > 255 * self.key.tag_len() {
            return Err(tls13::OutputLengthError);
        }

        self.expand_unchecked(info, output);
        Ok(())
    }

    fn expand_block(&self, info: &[&[u8]]) -> tls13::OkmBlock {
        let mut scratch = [0u8; hmac::Tag::MAX_LEN];
        let block = {
            let mut scratch = Cleansing::new(&mut scratch[..]);
            let output = &mut scratch.as_mut_slice()[..self.key.tag_len()];
            self.expand_unchecked(info, output);
            tls13::OkmBlock::new(output)
        };
        block
    }

    fn hash_len(&self) -> usize {
        self.key.tag_len()
    }
}

#[cfg(test)]
mod tests {
    use rustls::crypto::hmac::{Hmac as _, Key as _};
    use rustls::crypto::tls13::Hkdf as _;

    use super::*;
    use crate::testutil::hex;

    #[test]
    fn hmac_sha256_rfc4231_case_2() {
        let key = HmacKey::new(HashKind::Sha256, b"Jefe");
        let tag = key.sign_concat(b"what do ya want ", &[], b"for nothing?");
        let expected = [
            0x5b, 0xdc, 0xc1, 0x46, 0xbf, 0x60, 0x75, 0x4e, 0x6a, 0x04, 0x24, 0x26, 0x08, 0x95,
            0x75, 0xc7, 0x5a, 0x00, 0x3f, 0x08, 0x9d, 0x27, 0x39, 0x83, 0x9d, 0xec, 0x58, 0xb9,
            0x64, 0xec, 0x38, 0x43,
        ];
        assert_eq!(tag.as_ref(), expected);
    }

    #[test]
    fn hmac_sha384_rfc4231_case_2() {
        let key = HmacKey::new(HashKind::Sha384, b"Jefe");
        let tag = key.sign_concat(b"what do ya want ", &[], b"for nothing?");
        let expected = [
            0xaf, 0x45, 0xd2, 0xe3, 0x76, 0x48, 0x40, 0x31, 0x61, 0x7f, 0x78, 0xd2, 0xb5, 0x8a,
            0x6b, 0x1b, 0x9c, 0x7e, 0xf4, 0x64, 0xf5, 0xa0, 0x1b, 0x47, 0xe4, 0x2e, 0xc3, 0x73,
            0x63, 0x22, 0x44, 0x5e, 0x8e, 0x22, 0x40, 0xca, 0x5e, 0x69, 0xe2, 0xc7, 0x8b, 0x32,
            0x39, 0xec, 0xfa, 0xb2, 0x16, 0x49,
        ];
        assert_eq!(tag.as_ref(), expected);
    }

    #[test]
    fn hmac_sha256_rfc4231_case_6_long_key_path() {
        // Case 6 uses a key longer than the block size, exercising key hashing.
        let key = HmacKey::new(HashKind::Sha256, &[0xaa; 131]);
        let tag = key.sign_concat(
            b"Test Using Large",
            &[b"r Than Block-Siz"],
            b"e Key - Hash Key First",
        );
        let expected = [
            0x60, 0xe4, 0x31, 0x59, 0x1e, 0xe0, 0xb6, 0x7f, 0x0d, 0x8a, 0x26, 0xaa, 0xcb, 0xf5,
            0xb7, 0x7f, 0x8e, 0x0b, 0xc6, 0x21, 0x37, 0x28, 0xc5, 0x14, 0x05, 0x46, 0x04, 0x0f,
            0x0e, 0xe3, 0x7f, 0x54,
        ];
        assert_eq!(tag.as_ref(), expected);
    }

    #[test]
    fn hmac_sha384_rfc4231_case_6_long_key_path() {
        // Case 6 is longer than SHA-384's 128-byte block size.
        let key = HmacKey::new(HashKind::Sha384, &[0xaa; 131]);
        let tag = key.sign_concat(
            b"Test Using Large",
            &[b"r Than Block-Siz"],
            b"e Key - Hash Key First",
        );
        assert_eq!(
            tag.as_ref(),
            hex(
                "4ece084485813e9088d2c63a041bc5b44f9ef1012a2b588f3cd11f05033ac4c6\
                 0c2ef6ab4030fe8296248df163f44952"
            )
        );
    }

    #[test]
    fn hmac_empty_key_and_message() {
        let sha256 = HmacKey::new(HashKind::Sha256, &[]).sign(&[b""]);
        assert_eq!(
            sha256.as_ref(),
            hex("b613679a0814d9ec772f95d778c35fc5ff1697c493715653c6c712144292c5ad")
        );

        let sha384 = HmacKey::new(HashKind::Sha384, &[]).sign(&[b""]);
        assert_eq!(
            sha384.as_ref(),
            hex(
                "6c1f2ee938fad2e24bd91298474382ca218c75db3d83e114b3d4367776d14d35\
                 51289e75e8209cd4b792302840234adc"
            )
        );
    }

    #[test]
    fn hmac_exact_block_size_keys() {
        let sha256 = HmacKey::new(HashKind::Sha256, &[0x0b; 64]).sign(&[b"exact block-size key"]);
        assert_eq!(
            sha256.as_ref(),
            hex("ae543dfe554b858a4d665c944e66ec714490bc4940c92d680585d33bd741f787")
        );

        let sha384 = HmacKey::new(HashKind::Sha384, &[0x0b; 128]).sign(&[b"exact block-size key"]);
        assert_eq!(
            sha384.as_ref(),
            hex(
                "b869b0e37005c1d88d46074c2c20f290722acda4dfcf1da036bcb08bd88867f9\
                 2e50c3f9843178163add1cc2f205d6af"
            )
        );
    }

    #[test]
    fn hkdf_sha256_rfc5869_case_1() {
        let ikm = [0x0b; 22];
        let salt: Vec<u8> = (0x00..=0x0c).collect();
        let info: Vec<u8> = (0xf0..=0xf9).collect();

        let expander = HKDF_SHA256.extract_from_secret(Some(&salt), &ikm);
        let mut okm = [0u8; 42];
        expander.expand_slice(&[&info], &mut okm).unwrap();

        let expected = [
            0x3c, 0xb2, 0x5f, 0x25, 0xfa, 0xac, 0xd5, 0x7a, 0x90, 0x43, 0x4f, 0x64, 0xd0, 0x36,
            0x2f, 0x2a, 0x2d, 0x2d, 0x0a, 0x90, 0xcf, 0x1a, 0x5a, 0x4c, 0x5d, 0xb0, 0x2d, 0x56,
            0xec, 0xc4, 0xc5, 0xbf, 0x34, 0x00, 0x72, 0x08, 0xd5, 0xb8, 0x87, 0x18, 0x58, 0x65,
        ];
        assert_eq!(okm, expected);
    }

    #[test]
    fn hkdf_sha384_known_answer() {
        // RFC 5869 case 1 inputs, with the SHA-384 expected output from
        // BoringSSL's multi-digest HKDF known-answer tests.
        let ikm = [0x0b; 22];
        let salt: Vec<u8> = (0x00..=0x0c).collect();
        let info: Vec<u8> = (0xf0..=0xf9).collect();

        let expander = HKDF_SHA384.extract_from_secret(Some(&salt), &ikm);
        let mut okm = [0u8; 42];
        expander.expand_slice(&[&info], &mut okm).unwrap();

        let expected = [
            0x9b, 0x50, 0x97, 0xa8, 0x60, 0x38, 0xb8, 0x05, 0x30, 0x90, 0x76, 0xa4, 0x4b, 0x3a,
            0x9f, 0x38, 0x06, 0x3e, 0x25, 0xb5, 0x16, 0xdc, 0xbf, 0x36, 0x9f, 0x39, 0x4c, 0xfa,
            0xb4, 0x36, 0x85, 0xf7, 0x48, 0xb6, 0x45, 0x77, 0x63, 0xe4, 0xf0, 0x20, 0x4f, 0xc5,
        ];
        assert_eq!(okm, expected);
    }

    #[test]
    fn hkdf_sha384_multiblock_known_answer() {
        let ikm = [0x0b; 22];
        let salt: Vec<u8> = (0x00..=0x0c).collect();
        let info: Vec<u8> = (0xf0..=0xf9).collect();

        let expander = HKDF_SHA384.extract_from_secret(Some(&salt), &ikm);
        let mut okm = [0u8; 82];
        expander.expand_slice(&[&info], &mut okm).unwrap();
        assert_eq!(
            okm.as_slice(),
            hex(
                "9b5097a86038b805309076a44b3a9f38063e25b516dcbf369f394cfab43685f7\
                 48b6457763e4f0204fc5d95d1da3e62587b22eb8943d0fab6bb631a2fe9df1a6\
                 8c6ce5d56116a52005b3f122b88b39b7251f"
            )
        );
    }

    #[test]
    fn hkdf_sha256_no_salt_and_empty_info_rfc5869_case_3() {
        let expander = HKDF_SHA256.extract_from_secret(None, &[0x0b; 22]);
        let mut okm = [0u8; 42];
        expander.expand_slice(&[], &mut okm).unwrap();
        assert_eq!(
            okm.as_slice(),
            hex(
                "8da4e775a563c18f715f802a063c5a31b8a11f5c5ee1879ec3454e5f3c738d2d\
                 9d201395faa4b61a96c8"
            )
        );
    }

    #[test]
    fn hkdf_auxiliary_trait_paths_match_the_primitive() {
        let zero_ikm = [0u8; 32];
        let from_zero = HKDF_SHA256.extract_from_zero_ikm(Some(b"salt"));
        let from_secret = HKDF_SHA256.extract_from_secret(Some(b"salt"), &zero_ikm);
        assert_eq!(from_zero.hash_len(), 32);

        let block = from_zero.expand_block(&[b"info"]);
        let mut slice = [0u8; 32];
        from_secret.expand_slice(&[b"info"], &mut slice).unwrap();
        assert_eq!(block.as_ref(), slice);

        let expander = HKDF_SHA256.expander_for_okm(&block);
        let mut expanded = [0u8; 32];
        expander.expand_slice(&[b"next"], &mut expanded).unwrap();
        let direct = HkdfExpander {
            key: Box::new(HmacKey::new(HashKind::Sha256, block.as_ref())),
        };
        let mut expected = [0u8; 32];
        tls13::HkdfExpander::expand_slice(&direct, &[b"next"], &mut expected).unwrap();
        assert_eq!(expanded, expected);

        let tag = HKDF_SHA256.hmac_sign(&block, b"message");
        let expected = HmacKey::new(HashKind::Sha256, block.as_ref()).sign(&[b"message"]);
        assert_eq!(tag.as_ref(), expected.as_ref());
    }

    #[test]
    fn hkdf_enforces_rfc5869_output_limit_without_writing_on_error() {
        for (hkdf, hash_len) in [
            (&HKDF_SHA256 as &dyn tls13::Hkdf, 32),
            (&HKDF_SHA384 as &dyn tls13::Hkdf, 48),
        ] {
            let expander = hkdf.extract_from_secret(Some(b"salt"), b"secret");
            let mut maximum = vec![0u8; 255 * hash_len];
            assert!(expander.expand_slice(&[b"info"], &mut maximum).is_ok());
            assert!(maximum.iter().any(|&byte| byte != 0));

            let mut too_long = vec![0xa5; 255 * hash_len + 1];
            assert!(expander.expand_slice(&[b"info"], &mut too_long).is_err());
            assert!(too_long.iter().all(|&byte| byte == 0xa5));
        }
    }

    #[test]
    fn hmac_output_lens() {
        assert_eq!(SHA256.hash_output_len(), 32);
        assert_eq!(SHA384.hash_output_len(), 48);
    }

    #[test]
    fn cleansing_guard_zeroes_on_drop() {
        let mut secret = [0xa5; 64];
        {
            let _guard = Cleansing::new(&mut secret[..]);
        }
        assert!(secret.iter().all(|&byte| byte == 0));
    }
}
