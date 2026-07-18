// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! A [`rustls::crypto::CryptoProvider`] backed by BoringSSL, via the in-tree
//! `openssl` crate bindings.
//!
//! This exists because our TLS library is BoringSSL: `ring` and `aws-lc-rs`
//! are banned from the build graph, so any rustls user (iroh/noq being the
//! big one) must install a crypto provider at runtime. This is that provider.
//!
//! What it offers:
//!
//! - TLS 1.3 only, with `TLS13_AES_256_GCM_SHA384`, `TLS13_AES_128_GCM_SHA256`
//!   (mandatory for QUIC v1 initial packets), and
//!   `TLS13_CHACHA20_POLY1305_SHA256`. All record and packet AEADs go
//!   through BoringSSL's `EVP_AEAD` interface via `bssl_sys`, with one
//!   long-lived context per traffic key and in-place sealing; the `openssl`
//!   crate bindings cover hashing, key exchange and signatures.
//! - QUIC packet protection (including the multipath nonce variants used
//!   by noq).
//! - X25519MLKEM768 hybrid post-quantum key exchange (preferred and offered
//!   alongside a classical share, so non-PQ servers negotiate X25519 with
//!   no extra round trip), plus X25519, P-256 and P-384.
//! - Certificate verification for Ed25519, ECDSA P-256/P-384, and
//!   RSA PKCS#1/PSS — enough for iroh's raw-public-key TLS and for WebPKI
//!   verification of relay/DoH endpoints.
//! - Private keys for Ed25519, ECDSA and RSA via [`KeyProvider`].
//!
//! Usage with iroh:
//!
//! ```ignore
//! let endpoint = iroh::Endpoint::builder()
//!     .crypto_provider(rustls_boring::arc_provider())
//!     .bind()
//!     .await?;
//! ```
//!
//! For code paths that consult the rustls process-level default (e.g.
//! reqwest built with `rustls-no-provider`), install it once at startup:
//!
//! ```ignore
//! rustls_boring::provider().install_default().expect("provider already installed");
//! ```

use std::sync::Arc;

use rustls::crypto::{CryptoProvider, GetRandomFailed, SecureRandom};

mod aead;
mod hash;
mod hmac;
mod kx;
mod mlkem;
mod quic;
mod sign;
mod suites;
mod verify;

#[cfg(test)]
mod handshake_test;

pub use suites::{
    TLS13_AES_128_GCM_SHA256, TLS13_AES_256_GCM_SHA384, TLS13_CHACHA20_POLY1305_SHA256,
};

/// The individual key exchange groups, for building a provider restricted
/// to a subset — e.g. X25519MLKEM768 alone to *require* post-quantum key
/// exchange:
///
/// ```ignore
/// let pq_only = rustls::crypto::CryptoProvider {
///     kx_groups: vec![rustls_boring::kx_group::X25519MLKEM768],
///     ..rustls_boring::provider()
/// };
/// ```
pub mod kx_group {
    use rustls::crypto::SupportedKxGroup;

    pub static X25519MLKEM768: &dyn SupportedKxGroup = &crate::kx::X25519MLKEM768;
    pub static X25519: &dyn SupportedKxGroup = &crate::kx::X25519;
    pub static SECP256R1: &dyn SupportedKxGroup = &crate::kx::SECP256R1;
    pub static SECP384R1: &dyn SupportedKxGroup = &crate::kx::SECP384R1;
}

/// Build the BoringSSL-backed provider.
pub fn provider() -> CryptoProvider {
    CryptoProvider {
        cipher_suites: suites::ALL_CIPHER_SUITES.to_vec(),
        kx_groups: kx::ALL_KX_GROUPS.to_vec(),
        signature_verification_algorithms: verify::SUPPORTED_SIG_ALGS,
        secure_random: &BoringRandom,
        key_provider: &sign::BoringKeyProvider,
    }
}

/// [`provider`], pre-wrapped in an [`Arc`] for APIs that take one.
pub fn arc_provider() -> Arc<CryptoProvider> {
    Arc::new(provider())
}

#[derive(Debug)]
struct BoringRandom;

impl SecureRandom for BoringRandom {
    fn fill(&self, buf: &mut [u8]) -> Result<(), GetRandomFailed> {
        openssl::rand::rand_bytes(buf).map_err(|_| GetRandomFailed)
    }
}

/// Map a BoringSSL error stack onto the generic rustls error.
fn general_error(context: &str, err: openssl::error::ErrorStack) -> rustls::Error {
    rustls::Error::General(format!("boringssl {context}: {err}"))
}

/// Zero a buffer holding secret material, through BoringSSL's cleanse so
/// the write cannot be elided by the optimizer.
pub(crate) fn cleanse(bytes: &mut [u8]) {
    // SAFETY: the pointer/length denote exactly the valid, writable buffer.
    unsafe { bssl_sys::OPENSSL_cleanse(bytes.as_mut_ptr().cast(), bytes.len()) }
}

#[cfg(test)]
pub(crate) mod testutil {
    pub(crate) fn arr<const N: usize>(bytes: &[u8]) -> [u8; N] {
        bytes.try_into().expect("vector of the declared length")
    }

    pub(crate) fn hex(s: &str) -> Vec<u8> {
        let s: String = s.chars().filter(|c| !c.is_whitespace()).collect();
        (0..s.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap())
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn random_fills() {
        let mut buf = [0u8; 64];
        provider().secure_random.fill(&mut buf).unwrap();
        assert_ne!(buf, [0u8; 64]);
    }

    #[test]
    fn provider_has_quic_capable_initial_suite() {
        let p = provider();
        let has_initial = p.cipher_suites.iter().any(|s| {
            s.tls13().is_some_and(|s13| {
                s13.quic.is_some()
                    && s13.common.suite == rustls::CipherSuite::TLS13_AES_128_GCM_SHA256
            })
        });
        assert!(
            has_initial,
            "QUIC v1 requires TLS13_AES_128_GCM_SHA256 with quic support"
        );
    }
}
