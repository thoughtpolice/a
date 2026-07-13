// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! The TLS 1.3 cipher suites offered by this provider.

use rustls::crypto::CipherSuiteCommon;
use rustls::{CipherSuite, SupportedCipherSuite, Tls13CipherSuite};

use crate::{aead, hash, hmac, quic};

pub(crate) static ALL_CIPHER_SUITES: &[SupportedCipherSuite] = &[
    TLS13_AES_256_GCM_SHA384,
    TLS13_AES_128_GCM_SHA256,
    TLS13_CHACHA20_POLY1305_SHA256,
];

/// TLS 1.3 AES-256-GCM with SHA-384 transcript hashing.
pub static TLS13_AES_256_GCM_SHA384: SupportedCipherSuite =
    SupportedCipherSuite::Tls13(&Tls13CipherSuite {
        common: CipherSuiteCommon {
            suite: CipherSuite::TLS13_AES_256_GCM_SHA384,
            hash_provider: &hash::SHA384,
            confidentiality_limit: 1 << 24,
        },
        hkdf_provider: &hmac::HKDF_SHA384,
        aead_alg: &aead::AES_256_GCM,
        quic: Some(&quic::AES_256_GCM),
    });

/// TLS 1.3 AES-128-GCM with SHA-256 transcript hashing.
///
/// QUIC v1 requires this suite: initial packets are always protected with it.
pub static TLS13_AES_128_GCM_SHA256: SupportedCipherSuite =
    SupportedCipherSuite::Tls13(&Tls13CipherSuite {
        common: CipherSuiteCommon {
            suite: CipherSuite::TLS13_AES_128_GCM_SHA256,
            hash_provider: &hash::SHA256,
            confidentiality_limit: 1 << 24,
        },
        hkdf_provider: &hmac::HKDF_SHA256,
        aead_alg: &aead::AES_128_GCM,
        quic: Some(&quic::AES_128_GCM),
    });

/// TLS 1.3 ChaCha20-Poly1305 with SHA-256 transcript hashing.
pub static TLS13_CHACHA20_POLY1305_SHA256: SupportedCipherSuite =
    SupportedCipherSuite::Tls13(&Tls13CipherSuite {
        common: CipherSuiteCommon {
            suite: CipherSuite::TLS13_CHACHA20_POLY1305_SHA256,
            hash_provider: &hash::SHA256,
            // RFC 9001 §6.6: the limit exceeds the protectable record count.
            confidentiality_limit: u64::MAX,
        },
        hkdf_provider: &hmac::HKDF_SHA256,
        aead_alg: &aead::CHACHA20_POLY1305,
        quic: Some(&quic::CHACHA20_POLY1305),
    });
