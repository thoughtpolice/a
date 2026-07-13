// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! SHA-2 hashing for the TLS handshake transcript.
//!
//! Digest operations `expect` success: BoringSSL digest calls fail only on
//! allocation failure, and the rustls `hash::Context` trait has no error
//! path, so panicking mirrors the upstream `ring` provider's behaviour.

use openssl::hash::{Hasher, MessageDigest};
use rustls::crypto::hash;

pub(crate) static SHA256: Sha2 = Sha2(HashKind::Sha256);
pub(crate) static SHA384: Sha2 = Sha2(HashKind::Sha384);

#[derive(Clone, Copy, Debug)]
pub(crate) enum HashKind {
    Sha256,
    Sha384,
}

impl HashKind {
    pub(crate) fn digest(self) -> MessageDigest {
        match self {
            Self::Sha256 => MessageDigest::sha256(),
            Self::Sha384 => MessageDigest::sha384(),
        }
    }

    pub(crate) fn output_len(self) -> usize {
        match self {
            Self::Sha256 => 32,
            Self::Sha384 => 48,
        }
    }

    pub(crate) fn block_len(self) -> usize {
        match self {
            Self::Sha256 => 64,
            Self::Sha384 => 128,
        }
    }
}

pub(crate) struct Sha2(HashKind);

impl hash::Hash for Sha2 {
    fn start(&self) -> Box<dyn hash::Context> {
        Box::new(Sha2Context(
            Hasher::new(self.0.digest()).expect("BoringSSL failed to create digest context"),
        ))
    }

    fn hash(&self, data: &[u8]) -> hash::Output {
        let digest = openssl::hash::hash(self.0.digest(), data).expect("BoringSSL failed to hash");
        hash::Output::new(&digest)
    }

    fn output_len(&self) -> usize {
        self.0.output_len()
    }

    fn algorithm(&self) -> hash::HashAlgorithm {
        match self.0 {
            HashKind::Sha256 => hash::HashAlgorithm::SHA256,
            HashKind::Sha384 => hash::HashAlgorithm::SHA384,
        }
    }
}

struct Sha2Context(Hasher);

impl hash::Context for Sha2Context {
    fn fork_finish(&self) -> hash::Output {
        let mut fork = self.0.clone();
        hash::Output::new(&fork.finish().expect("BoringSSL failed to finish digest"))
    }

    fn fork(&self) -> Box<dyn hash::Context> {
        Box::new(Sha2Context(self.0.clone()))
    }

    fn finish(mut self: Box<Self>) -> hash::Output {
        hash::Output::new(&self.0.finish().expect("BoringSSL failed to finish digest"))
    }

    fn update(&mut self, data: &[u8]) {
        self.0
            .update(data)
            .expect("BoringSSL failed to update digest");
    }
}

#[cfg(test)]
mod tests {
    use rustls::crypto::hash::Hash;

    use super::*;
    use crate::testutil::hex;

    #[test]
    fn sha256_one_shot_matches_incremental_and_fork() {
        // FIPS 180-2 test vector: SHA-256("abc")
        let expected = [
            0xba, 0x78, 0x16, 0xbf, 0x8f, 0x01, 0xcf, 0xea, 0x41, 0x41, 0x40, 0xde, 0x5d, 0xae,
            0x22, 0x23, 0xb0, 0x03, 0x61, 0xa3, 0x96, 0x17, 0x7a, 0x9c, 0xb4, 0x10, 0xff, 0x61,
            0xf2, 0x00, 0x15, 0xad,
        ];
        assert_eq!(SHA256.hash(b"abc").as_ref(), expected);

        let mut ctx = SHA256.start();
        ctx.update(b"a");
        ctx.update(b"bc");
        assert_eq!(ctx.fork_finish().as_ref(), expected);
        let fork = ctx.fork();
        assert_eq!(fork.finish().as_ref(), expected);
    }

    #[test]
    fn sha384_kat() {
        // FIPS 180-2 test vector: SHA-384("abc")
        let expected: &[u8] = &[
            0xcb, 0x00, 0x75, 0x3f, 0x45, 0xa3, 0x5e, 0x8b, 0xb5, 0xa0, 0x3d, 0x69, 0x9a, 0xc6,
            0x50, 0x07, 0x27, 0x2c, 0x32, 0xab, 0x0e, 0xde, 0xd1, 0x63, 0x1a, 0x8b, 0x60, 0x5a,
            0x43, 0xff, 0x5b, 0xed, 0x80, 0x86, 0x07, 0x2b, 0xa1, 0xe7, 0xcc, 0x23, 0x58, 0xba,
            0xec, 0xa1, 0x34, 0xc8, 0x25, 0xa7,
        ];
        assert_eq!(SHA384.hash(b"abc").as_ref(), expected);
        assert_eq!(SHA384.output_len(), 48);

        let mut ctx = SHA384.start();
        ctx.update(b"a");
        let mut fork = ctx.fork();
        ctx.update(b"bc");
        fork.update(b"bc");
        assert_eq!(ctx.fork_finish().as_ref(), expected);
        assert_eq!(ctx.finish().as_ref(), expected);
        assert_eq!(fork.finish().as_ref(), expected);
    }

    #[test]
    fn sha2_empty_vectors_and_metadata() {
        assert_eq!(
            SHA256.hash(&[]).as_ref(),
            hex("e3b0c44298fc1c149afbf4c8996fb924\
                 27ae41e4649b934ca495991b7852b855")
        );
        assert_eq!(
            SHA384.hash(&[]).as_ref(),
            hex("38b060a751ac96384cd9327eb1b1e36a\
                 21fdb71114be07434c0cc7bf63f6e1da\
                 274edebfe76f65fbd51ad2f14898b95b")
        );
        assert_eq!(SHA256.output_len(), 32);
        assert_eq!(SHA384.output_len(), 48);
        assert_eq!(HashKind::Sha256.block_len(), 64);
        assert_eq!(HashKind::Sha384.block_len(), 128);
        assert_eq!(SHA256.algorithm(), hash::HashAlgorithm::SHA256);
        assert_eq!(SHA384.algorithm(), hash::HashAlgorithm::SHA384);
    }
}
