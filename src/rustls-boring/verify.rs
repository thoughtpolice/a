// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! Signature verification algorithms, used both for WebPKI certificate
//! chains (relays, DNS-over-HTTPS, ...) and TLS 1.3 handshake signatures.

use openssl::bn::BigNumContext;
use openssl::ec::{EcGroup, EcKey, EcPoint};
use openssl::hash::MessageDigest;
use openssl::nid::Nid;
use openssl::pkey::{Id, PKey, Public};
use openssl::rsa::{Padding, Rsa};
use openssl::sign::{RsaPssSaltlen, Verifier};
use rustls::SignatureScheme;
use rustls::crypto::WebPkiSupportedAlgorithms;
use rustls::pki_types::{
    AlgorithmIdentifier, InvalidSignature, SignatureVerificationAlgorithm, alg_id,
};

pub(crate) static SUPPORTED_SIG_ALGS: WebPkiSupportedAlgorithms = WebPkiSupportedAlgorithms {
    all: &[
        ED25519,
        ECDSA_P256_SHA256,
        ECDSA_P256_SHA384,
        ECDSA_P256_SHA512,
        ECDSA_P384_SHA256,
        ECDSA_P384_SHA384,
        ECDSA_P384_SHA512,
        RSA_PSS_SHA256,
        RSA_PSS_SHA384,
        RSA_PSS_SHA512,
        RSA_PKCS1_SHA256,
        RSA_PKCS1_SHA384,
        RSA_PKCS1_SHA512,
        RSA_PKCS1_SHA256_ABSENT_PARAMS,
        RSA_PKCS1_SHA384_ABSENT_PARAMS,
        RSA_PKCS1_SHA512_ABSENT_PARAMS,
    ],
    mapping: &[
        (SignatureScheme::ED25519, &[ED25519]),
        // In TLS 1.2 the SignatureScheme fixes the digest but not the
        // certificate curve. TLS 1.3 applies its stricter curve requirement
        // separately, so both supported curves must be available here.
        (
            SignatureScheme::ECDSA_NISTP384_SHA384,
            &[ECDSA_P384_SHA384, ECDSA_P256_SHA384],
        ),
        (
            SignatureScheme::ECDSA_NISTP256_SHA256,
            &[ECDSA_P256_SHA256, ECDSA_P384_SHA256],
        ),
        (SignatureScheme::RSA_PSS_SHA256, &[RSA_PSS_SHA256]),
        (SignatureScheme::RSA_PSS_SHA384, &[RSA_PSS_SHA384]),
        (SignatureScheme::RSA_PSS_SHA512, &[RSA_PSS_SHA512]),
        (SignatureScheme::RSA_PKCS1_SHA256, &[RSA_PKCS1_SHA256]),
        (SignatureScheme::RSA_PKCS1_SHA384, &[RSA_PKCS1_SHA384]),
        (SignatureScheme::RSA_PKCS1_SHA512, &[RSA_PKCS1_SHA512]),
    ],
};

pub(crate) const ED25519: &dyn SignatureVerificationAlgorithm = &BoringVerify {
    public_key_alg_id: alg_id::ED25519,
    signature_alg_id: alg_id::ED25519,
    kind: KeyKind::Ed25519,
    digest: None,
};

pub(crate) const ECDSA_P256_SHA256: &dyn SignatureVerificationAlgorithm = &BoringVerify {
    public_key_alg_id: alg_id::ECDSA_P256,
    signature_alg_id: alg_id::ECDSA_SHA256,
    kind: KeyKind::Ec(EcCurve::P256),
    digest: Some(Digest::Sha256),
};

pub(crate) const ECDSA_P256_SHA384: &dyn SignatureVerificationAlgorithm = &BoringVerify {
    public_key_alg_id: alg_id::ECDSA_P256,
    signature_alg_id: alg_id::ECDSA_SHA384,
    kind: KeyKind::Ec(EcCurve::P256),
    digest: Some(Digest::Sha384),
};

pub(crate) const ECDSA_P256_SHA512: &dyn SignatureVerificationAlgorithm = &BoringVerify {
    public_key_alg_id: alg_id::ECDSA_P256,
    signature_alg_id: alg_id::ECDSA_SHA512,
    kind: KeyKind::Ec(EcCurve::P256),
    digest: Some(Digest::Sha512),
};

pub(crate) const ECDSA_P384_SHA256: &dyn SignatureVerificationAlgorithm = &BoringVerify {
    public_key_alg_id: alg_id::ECDSA_P384,
    signature_alg_id: alg_id::ECDSA_SHA256,
    kind: KeyKind::Ec(EcCurve::P384),
    digest: Some(Digest::Sha256),
};

pub(crate) const ECDSA_P384_SHA384: &dyn SignatureVerificationAlgorithm = &BoringVerify {
    public_key_alg_id: alg_id::ECDSA_P384,
    signature_alg_id: alg_id::ECDSA_SHA384,
    kind: KeyKind::Ec(EcCurve::P384),
    digest: Some(Digest::Sha384),
};

pub(crate) const ECDSA_P384_SHA512: &dyn SignatureVerificationAlgorithm = &BoringVerify {
    public_key_alg_id: alg_id::ECDSA_P384,
    signature_alg_id: alg_id::ECDSA_SHA512,
    kind: KeyKind::Ec(EcCurve::P384),
    digest: Some(Digest::Sha512),
};

pub(crate) const RSA_PKCS1_SHA256: &dyn SignatureVerificationAlgorithm = &BoringVerify {
    public_key_alg_id: alg_id::RSA_ENCRYPTION,
    signature_alg_id: alg_id::RSA_PKCS1_SHA256,
    kind: KeyKind::RsaPkcs1,
    digest: Some(Digest::Sha256),
};

pub(crate) const RSA_PKCS1_SHA384: &dyn SignatureVerificationAlgorithm = &BoringVerify {
    public_key_alg_id: alg_id::RSA_ENCRYPTION,
    signature_alg_id: alg_id::RSA_PKCS1_SHA384,
    kind: KeyKind::RsaPkcs1,
    digest: Some(Digest::Sha384),
};

pub(crate) const RSA_PKCS1_SHA512: &dyn SignatureVerificationAlgorithm = &BoringVerify {
    public_key_alg_id: alg_id::RSA_ENCRYPTION,
    signature_alg_id: alg_id::RSA_PKCS1_SHA512,
    kind: KeyKind::RsaPkcs1,
    digest: Some(Digest::Sha512),
};

// RFC 4055 requires these AlgorithmIdentifiers to contain NULL parameters,
// but also requires verifiers to accept encodings where the parameters are
// absent. Certificate signature algorithm matching is exact, so each absent
// encoding needs its own otherwise-identical verifier.
const RSA_PKCS1_SHA256_ABSENT_PARAMS: &dyn SignatureVerificationAlgorithm = &BoringVerify {
    public_key_alg_id: alg_id::RSA_ENCRYPTION,
    signature_alg_id: AlgorithmIdentifier::from_slice(&[
        0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x0b,
    ]),
    kind: KeyKind::RsaPkcs1,
    digest: Some(Digest::Sha256),
};

const RSA_PKCS1_SHA384_ABSENT_PARAMS: &dyn SignatureVerificationAlgorithm = &BoringVerify {
    public_key_alg_id: alg_id::RSA_ENCRYPTION,
    signature_alg_id: AlgorithmIdentifier::from_slice(&[
        0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x0c,
    ]),
    kind: KeyKind::RsaPkcs1,
    digest: Some(Digest::Sha384),
};

const RSA_PKCS1_SHA512_ABSENT_PARAMS: &dyn SignatureVerificationAlgorithm = &BoringVerify {
    public_key_alg_id: alg_id::RSA_ENCRYPTION,
    signature_alg_id: AlgorithmIdentifier::from_slice(&[
        0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x0d,
    ]),
    kind: KeyKind::RsaPkcs1,
    digest: Some(Digest::Sha512),
};

pub(crate) const RSA_PSS_SHA256: &dyn SignatureVerificationAlgorithm = &BoringVerify {
    public_key_alg_id: alg_id::RSA_ENCRYPTION,
    signature_alg_id: alg_id::RSA_PSS_SHA256,
    kind: KeyKind::RsaPss,
    digest: Some(Digest::Sha256),
};

pub(crate) const RSA_PSS_SHA384: &dyn SignatureVerificationAlgorithm = &BoringVerify {
    public_key_alg_id: alg_id::RSA_ENCRYPTION,
    signature_alg_id: alg_id::RSA_PSS_SHA384,
    kind: KeyKind::RsaPss,
    digest: Some(Digest::Sha384),
};

pub(crate) const RSA_PSS_SHA512: &dyn SignatureVerificationAlgorithm = &BoringVerify {
    public_key_alg_id: alg_id::RSA_ENCRYPTION,
    signature_alg_id: alg_id::RSA_PSS_SHA512,
    kind: KeyKind::RsaPss,
    digest: Some(Digest::Sha512),
};

#[derive(Clone, Copy, Debug)]
enum EcCurve {
    P256,
    P384,
}

impl EcCurve {
    fn nid(self) -> Nid {
        match self {
            Self::P256 => Nid::X9_62_PRIME256V1,
            Self::P384 => Nid::SECP384R1,
        }
    }

    fn uncompressed_point_len(self) -> usize {
        match self {
            Self::P256 => 65,
            Self::P384 => 97,
        }
    }
}

#[derive(Clone, Copy, Debug)]
enum KeyKind {
    Ed25519,
    Ec(EcCurve),
    RsaPkcs1,
    RsaPss,
}

#[derive(Clone, Copy, Debug)]
enum Digest {
    Sha256,
    Sha384,
    Sha512,
}

impl Digest {
    fn md(self) -> MessageDigest {
        match self {
            Self::Sha256 => MessageDigest::sha256(),
            Self::Sha384 => MessageDigest::sha384(),
            Self::Sha512 => MessageDigest::sha512(),
        }
    }
}

#[derive(Debug)]
struct BoringVerify {
    public_key_alg_id: AlgorithmIdentifier,
    signature_alg_id: AlgorithmIdentifier,
    kind: KeyKind,
    digest: Option<Digest>,
}

impl BoringVerify {
    /// `public_key` is the raw SPKI `subjectPublicKey` contents: raw bytes
    /// for Ed25519, an uncompressed point for ECDSA, a PKCS#1
    /// `RSAPublicKey` for RSA.
    fn load_key(&self, public_key: &[u8]) -> Result<PKey<Public>, InvalidSignature> {
        match self.kind {
            KeyKind::Ed25519 => PKey::public_key_from_raw_bytes(public_key, Id::ED25519)
                .map_err(|_| InvalidSignature),
            KeyKind::Ec(curve) => {
                // RFC 5480 requires support for the uncompressed SEC1 form,
                // while compressed support is optional and hybrid encodings
                // are forbidden. Match rustls's built-in providers by
                // accepting only the exact uncompressed representation.
                if public_key.len() != curve.uncompressed_point_len()
                    || public_key.first() != Some(&0x04)
                {
                    return Err(InvalidSignature);
                }
                let group = EcGroup::from_curve_name(curve.nid()).map_err(|_| InvalidSignature)?;
                let mut ctx = BigNumContext::new().map_err(|_| InvalidSignature)?;
                let point = EcPoint::from_bytes(&group, public_key, &mut ctx)
                    .map_err(|_| InvalidSignature)?;
                let key = EcKey::from_public_key(&group, &point).map_err(|_| InvalidSignature)?;
                key.check_key().map_err(|_| InvalidSignature)?;
                PKey::from_ec_key(key).map_err(|_| InvalidSignature)
            }
            KeyKind::RsaPkcs1 | KeyKind::RsaPss => {
                let rsa =
                    Rsa::public_key_from_der_pkcs1(public_key).map_err(|_| InvalidSignature)?;
                // BoringSSL's d2i parser is strict DER but tolerates trailing
                // bytes; round-trip to reject them (strict DER is a unique
                // encoding, so byte inequality is exactly "trailing data").
                let round_trip = rsa
                    .public_key_to_der_pkcs1()
                    .map_err(|_| InvalidSignature)?;
                if round_trip != public_key {
                    return Err(InvalidSignature);
                }
                // Match the WebPKI convention of 2048..=8192 bit keys, on
                // the modulus's exact bit length.
                let bits = rsa.n().num_bits() as usize;
                if !(2048..=8192).contains(&bits) {
                    return Err(InvalidSignature);
                }
                PKey::from_rsa(rsa).map_err(|_| InvalidSignature)
            }
        }
    }
}

impl SignatureVerificationAlgorithm for BoringVerify {
    fn verify_signature(
        &self,
        public_key: &[u8],
        message: &[u8],
        signature: &[u8],
    ) -> Result<(), InvalidSignature> {
        let key = self.load_key(public_key)?;
        let ok = match self.kind {
            KeyKind::Ed25519 => {
                let mut verifier =
                    Verifier::new_without_digest(&key).map_err(|_| InvalidSignature)?;
                verifier
                    .verify_oneshot(signature, message)
                    .map_err(|_| InvalidSignature)?
            }
            KeyKind::Ec(_) | KeyKind::RsaPkcs1 => {
                let md = self.digest.expect("digest required").md();
                let mut verifier = Verifier::new(md, &key).map_err(|_| InvalidSignature)?;
                verifier.update(message).map_err(|_| InvalidSignature)?;
                verifier.verify(signature).map_err(|_| InvalidSignature)?
            }
            KeyKind::RsaPss => {
                let md = self.digest.expect("digest required").md();
                let mut verifier = Verifier::new(md, &key).map_err(|_| InvalidSignature)?;
                verifier
                    .set_rsa_padding(Padding::PKCS1_PSS)
                    .map_err(|_| InvalidSignature)?;
                verifier
                    .set_rsa_pss_saltlen(RsaPssSaltlen::DIGEST_LENGTH)
                    .map_err(|_| InvalidSignature)?;
                verifier.set_rsa_mgf1_md(md).map_err(|_| InvalidSignature)?;
                verifier.update(message).map_err(|_| InvalidSignature)?;
                verifier.verify(signature).map_err(|_| InvalidSignature)?
            }
        };
        if ok { Ok(()) } else { Err(InvalidSignature) }
    }

    fn public_key_alg_id(&self) -> AlgorithmIdentifier {
        self.public_key_alg_id
    }

    fn signature_alg_id(&self) -> AlgorithmIdentifier {
        self.signature_alg_id
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use openssl::asn1::Asn1Time;
    use openssl::bn::BigNum;
    use openssl::pkey::Private;
    use openssl::sign::Signer;
    use openssl::x509::extension::{
        BasicConstraints, ExtendedKeyUsage, KeyUsage, SubjectAlternativeName,
    };
    use openssl::x509::{X509, X509NameBuilder};
    use rustls::RootCertStore;
    use rustls::client::WebPkiServerVerifier;
    use rustls::client::danger::ServerCertVerifier;
    use rustls::pki_types::{CertificateDer, ServerName, UnixTime};

    use super::*;

    const RSA_SHA256_WITH_NULL_DER: &[u8] = &[
        0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x0b, 0x05, 0x00,
    ];
    const RSA_SHA256_ABSENT_PARAMS_DER: &[u8] = &[
        0x30, 0x0b, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x0b,
    ];
    const TEST_SERVER_NAME: &str = "rustls-boring.example";

    fn der_header(input: &[u8]) -> (usize, usize) {
        assert!(input.len() >= 2, "truncated DER header");
        let first = input[1];
        if first & 0x80 == 0 {
            let length = usize::from(first);
            assert!(2 + length <= input.len(), "truncated DER value");
            return (2, length);
        }

        let length_octets = usize::from(first & 0x7f);
        assert!(
            length_octets > 0 && length_octets <= size_of::<usize>(),
            "invalid DER length"
        );
        assert!(2 + length_octets <= input.len(), "truncated DER length");
        assert_ne!(input[2], 0, "non-minimal DER length");
        let mut length = 0usize;
        for &octet in &input[2..2 + length_octets] {
            length = length.checked_mul(256).unwrap() + usize::from(octet);
        }
        assert!(length >= 128, "non-minimal DER length");
        let header = 2 + length_octets;
        assert!(
            header.checked_add(length).unwrap() <= input.len(),
            "truncated DER value"
        );
        (header, length)
    }

    fn der_content(input: &[u8], expected_tag: u8) -> &[u8] {
        assert_eq!(input.first().copied(), Some(expected_tag));
        let (header, length) = der_header(input);
        assert_eq!(header + length, input.len(), "trailing DER data");
        &input[header..]
    }

    fn take_der_tlv(input: &[u8]) -> (&[u8], &[u8]) {
        let (header, length) = der_header(input);
        let total = header + length;
        (&input[..total], &input[total..])
    }

    fn der_wrap(tag: u8, content: &[u8]) -> Vec<u8> {
        let mut output = Vec::with_capacity(content.len() + 6);
        output.push(tag);
        if content.len() < 128 {
            output.push(content.len() as u8);
        } else {
            let bytes = content.len().to_be_bytes();
            let first = bytes.iter().position(|&octet| octet != 0).unwrap();
            let encoded = &bytes[first..];
            output.push(0x80 | encoded.len() as u8);
            output.extend_from_slice(encoded);
        }
        output.extend_from_slice(content);
        output
    }

    fn certificate_parts(certificate: &[u8]) -> (&[u8], &[u8], &[u8]) {
        let content = der_content(certificate, 0x30);
        let (tbs, rest) = take_der_tlv(content);
        let (signature_algorithm, rest) = take_der_tlv(rest);
        let (signature, rest) = take_der_tlv(rest);
        assert!(rest.is_empty(), "unexpected certificate fields");
        assert_eq!(tbs.first().copied(), Some(0x30));
        assert_eq!(signature_algorithm.first().copied(), Some(0x30));
        assert_eq!(signature.first().copied(), Some(0x03));
        (tbs, signature_algorithm, signature)
    }

    fn tbs_signature_algorithm(tbs: &[u8]) -> (usize, &[u8]) {
        let content = der_content(tbs, 0x30);
        let (first, mut rest) = take_der_tlv(content);
        let mut offset = first.len();
        if first[0] == 0xa0 {
            let (serial, remaining) = take_der_tlv(rest);
            assert_eq!(serial.first().copied(), Some(0x02));
            offset += serial.len();
            rest = remaining;
        } else {
            assert_eq!(first.first().copied(), Some(0x02));
        }
        let (algorithm, _) = take_der_tlv(rest);
        assert_eq!(algorithm.first().copied(), Some(0x30));
        (offset, algorithm)
    }

    fn certificate_with_signature_algorithm(
        certificate: &[u8],
        original_algorithm: &[u8],
        signature_algorithm: &[u8],
        sign: impl FnOnce(&[u8]) -> Vec<u8>,
    ) -> Vec<u8> {
        let (tbs, outer_algorithm, _) = certificate_parts(certificate);
        assert_eq!(outer_algorithm, original_algorithm);

        let tbs_content = der_content(tbs, 0x30);
        let (algorithm_offset, inner_algorithm) = tbs_signature_algorithm(tbs);
        assert_eq!(inner_algorithm, original_algorithm);
        let mut new_tbs_content = Vec::with_capacity(tbs_content.len() + signature_algorithm.len());
        new_tbs_content.extend_from_slice(&tbs_content[..algorithm_offset]);
        new_tbs_content.extend_from_slice(signature_algorithm);
        new_tbs_content.extend_from_slice(&tbs_content[algorithm_offset + inner_algorithm.len()..]);
        let new_tbs = der_wrap(0x30, &new_tbs_content);

        // Changing TBSCertificate invalidates the old signature. Sign the exact
        // modified DER and construct a fresh BIT STRING and outer Certificate.
        let signature = sign(&new_tbs);
        let mut bit_string = Vec::with_capacity(signature.len() + 1);
        bit_string.push(0); // DER BIT STRING unused-bit count.
        bit_string.extend_from_slice(&signature);
        let signature = der_wrap(0x03, &bit_string);

        let mut certificate_content =
            Vec::with_capacity(new_tbs.len() + signature_algorithm.len() + signature.len());
        certificate_content.extend_from_slice(&new_tbs);
        certificate_content.extend_from_slice(signature_algorithm);
        certificate_content.extend_from_slice(&signature);
        der_wrap(0x30, &certificate_content)
    }

    fn rsa_sha256_certificate_with_signature_algorithm(
        certificate: &[u8],
        issuer_key: &PKey<Private>,
        signature_algorithm: &[u8],
        pss: bool,
    ) -> Vec<u8> {
        certificate_with_signature_algorithm(
            certificate,
            RSA_SHA256_WITH_NULL_DER,
            signature_algorithm,
            |new_tbs| {
                let mut signer = Signer::new(MessageDigest::sha256(), issuer_key).unwrap();
                if pss {
                    signer.set_rsa_padding(Padding::PKCS1_PSS).unwrap();
                    signer
                        .set_rsa_pss_saltlen(RsaPssSaltlen::DIGEST_LENGTH)
                        .unwrap();
                    signer.set_rsa_mgf1_md(MessageDigest::sha256()).unwrap();
                } else {
                    signer.set_rsa_padding(Padding::PKCS1).unwrap();
                }
                signer.update(new_tbs).unwrap();
                signer.sign_to_vec().unwrap()
            },
        )
    }

    fn rsa_sha256_certificate_with_absent_params(
        certificate: &[u8],
        issuer_key: &PKey<Private>,
    ) -> Vec<u8> {
        rsa_sha256_certificate_with_signature_algorithm(
            certificate,
            issuer_key,
            RSA_SHA256_ABSENT_PARAMS_DER,
            false,
        )
    }

    fn rsa_sha256_certificate_with_pss(certificate: &[u8], issuer_key: &PKey<Private>) -> Vec<u8> {
        let algorithm = der_wrap(0x30, alg_id::RSA_PSS_SHA256.as_ref());
        rsa_sha256_certificate_with_signature_algorithm(certificate, issuer_key, &algorithm, true)
    }

    fn rsa_sha256_certificate_with_ed25519(
        certificate: &[u8],
        issuer_key: &PKey<Private>,
    ) -> Vec<u8> {
        let algorithm = der_wrap(0x30, alg_id::ED25519.as_ref());
        certificate_with_signature_algorithm(
            certificate,
            RSA_SHA256_WITH_NULL_DER,
            &algorithm,
            |new_tbs| {
                let mut signer = Signer::new_without_digest(issuer_key).unwrap();
                signer.sign_oneshot_to_vec(new_tbs).unwrap()
            },
        )
    }

    fn server_chain_with_template_signer(
        now: UnixTime,
        issuer_key: PKey<Private>,
        server_key: PKey<Private>,
        signature_digest: MessageDigest,
        template_signer: Option<&PKey<Private>>,
    ) -> (X509, PKey<Private>, X509) {
        let not_before = Asn1Time::from_unix(now.as_secs().saturating_sub(3600) as _).unwrap();
        let not_after = Asn1Time::from_unix((now.as_secs() + 86_400) as _).unwrap();

        let mut issuer_name = X509NameBuilder::new().unwrap();
        issuer_name
            .append_entry_by_text("CN", "rustls-boring test CA")
            .unwrap();
        let issuer_name = issuer_name.build();
        let issuer_serial = BigNum::from_u32(1).unwrap().to_asn1_integer().unwrap();
        let mut issuer = X509::builder().unwrap();
        issuer.set_version(2).unwrap();
        issuer.set_serial_number(&issuer_serial).unwrap();
        issuer.set_subject_name(&issuer_name).unwrap();
        issuer.set_issuer_name(&issuer_name).unwrap();
        issuer.set_not_before(&not_before).unwrap();
        issuer.set_not_after(&not_after).unwrap();
        issuer.set_pubkey(&issuer_key).unwrap();
        issuer
            .append_extension(BasicConstraints::new().critical().ca().build().unwrap())
            .unwrap();
        issuer
            .append_extension(
                KeyUsage::new()
                    .critical()
                    .key_cert_sign()
                    .crl_sign()
                    .build()
                    .unwrap(),
            )
            .unwrap();
        issuer
            .sign(template_signer.unwrap_or(&issuer_key), signature_digest)
            .unwrap();
        let issuer = issuer.build();

        let mut server_name = X509NameBuilder::new().unwrap();
        server_name
            .append_entry_by_text("CN", TEST_SERVER_NAME)
            .unwrap();
        let server_name = server_name.build();
        let server_serial = BigNum::from_u32(2).unwrap().to_asn1_integer().unwrap();
        let mut server = X509::builder().unwrap();
        server.set_version(2).unwrap();
        server.set_serial_number(&server_serial).unwrap();
        server.set_subject_name(&server_name).unwrap();
        server.set_issuer_name(issuer.subject_name()).unwrap();
        server.set_not_before(&not_before).unwrap();
        server.set_not_after(&not_after).unwrap();
        server.set_pubkey(&server_key).unwrap();
        server
            .append_extension(BasicConstraints::new().critical().build().unwrap())
            .unwrap();
        server
            .append_extension(
                KeyUsage::new()
                    .critical()
                    .digital_signature()
                    .key_encipherment()
                    .build()
                    .unwrap(),
            )
            .unwrap();
        server
            .append_extension(ExtendedKeyUsage::new().server_auth().build().unwrap())
            .unwrap();
        let subject_alt_name = SubjectAlternativeName::new()
            .dns(TEST_SERVER_NAME)
            .build(&server.x509v3_context(Some(&issuer), None))
            .unwrap();
        server.append_extension(subject_alt_name).unwrap();
        server
            .sign(template_signer.unwrap_or(&issuer_key), signature_digest)
            .unwrap();
        (issuer, issuer_key, server.build())
    }

    fn server_chain(
        now: UnixTime,
        issuer_key: PKey<Private>,
        server_key: PKey<Private>,
        signature_digest: MessageDigest,
    ) -> (X509, PKey<Private>, X509) {
        server_chain_with_template_signer(now, issuer_key, server_key, signature_digest, None)
    }

    fn ed25519_server_chain(
        now: UnixTime,
        issuer_key: PKey<Private>,
        server_key: PKey<Private>,
    ) -> (X509, PKey<Private>, X509) {
        // The safe X509Builder API requires an EVP_MD even though Ed25519
        // requires no external digest. Use RSA signatures only to obtain the
        // certificate/TBSCertificate framing, then replace and re-sign both
        // certificates below.
        let template_signer = PKey::from_rsa(Rsa::generate(2048).unwrap()).unwrap();
        let (issuer_template, issuer_key, server_template) = server_chain_with_template_signer(
            now,
            issuer_key,
            server_key,
            MessageDigest::sha256(),
            Some(&template_signer),
        );
        let issuer_der =
            rsa_sha256_certificate_with_ed25519(&issuer_template.to_der().unwrap(), &issuer_key);
        let issuer = X509::from_der(&issuer_der).unwrap();
        let server_der =
            rsa_sha256_certificate_with_ed25519(&server_template.to_der().unwrap(), &issuer_key);
        let server = X509::from_der(&server_der).unwrap();
        (issuer, issuer_key, server)
    }

    fn verify_server_path(issuer: &X509, server_der: Vec<u8>, now: UnixTime) {
        let mut roots = RootCertStore::empty();
        roots
            .add(CertificateDer::from(issuer.to_der().unwrap()))
            .unwrap();
        let verifier = WebPkiServerVerifier::builder_with_provider(
            Arc::new(roots),
            Arc::new(crate::provider()),
        )
        .build()
        .unwrap();
        let server_name = ServerName::try_from(TEST_SERVER_NAME).unwrap();
        verifier
            .verify_server_cert(
                &CertificateDer::from(server_der),
                &[],
                &server_name,
                &[],
                now,
            )
            .unwrap();
    }

    #[test]
    fn ed25519_rfc8032_test_1() {
        // RFC 8032 §7.1 TEST 1: empty message.
        let public_key = [
            0xd7, 0x5a, 0x98, 0x01, 0x82, 0xb1, 0x0a, 0xb7, 0xd5, 0x4b, 0xfe, 0xd3, 0xc9, 0x64,
            0x07, 0x3a, 0x0e, 0xe1, 0x72, 0xf3, 0xda, 0xa6, 0x23, 0x25, 0xaf, 0x02, 0x1a, 0x68,
            0xf7, 0x07, 0x51, 0x1a,
        ];
        let signature = [
            0xe5, 0x56, 0x43, 0x00, 0xc3, 0x60, 0xac, 0x72, 0x90, 0x86, 0xe2, 0xcc, 0x80, 0x6e,
            0x82, 0x8a, 0x84, 0x87, 0x7f, 0x1e, 0xb8, 0xe5, 0xd9, 0x74, 0xd8, 0x73, 0xe0, 0x65,
            0x22, 0x49, 0x01, 0x55, 0x5f, 0xb8, 0x82, 0x15, 0x90, 0xa3, 0x3b, 0xac, 0xc6, 0x1e,
            0x39, 0x70, 0x1c, 0xf9, 0xb4, 0x6b, 0xd2, 0x5b, 0xf5, 0xf0, 0x59, 0x5b, 0xbe, 0x24,
            0x65, 0x51, 0x41, 0x43, 0x8e, 0x7a, 0x10, 0x0b,
        ];
        ED25519
            .verify_signature(&public_key, b"", &signature)
            .unwrap();
        assert!(
            ED25519
                .verify_signature(&public_key, b"x", &signature)
                .is_err()
        );
    }

    fn assert_ecdsa_roundtrips(
        curve: Nid,
        algorithms: &[(&dyn SignatureVerificationAlgorithm, MessageDigest)],
    ) {
        let group = EcGroup::from_curve_name(curve).unwrap();
        let key = EcKey::generate(&group).unwrap();
        let pkey = PKey::from_ec_key(key.clone()).unwrap();
        let mut ctx = BigNumContext::new().unwrap();
        let point_bytes = key
            .public_key()
            .to_bytes(
                &group,
                openssl::ec::PointConversionForm::UNCOMPRESSED,
                &mut ctx,
            )
            .unwrap();

        for &(algorithm, digest) in algorithms {
            let mut signer = Signer::new(digest, &pkey).unwrap();
            signer.update(b"signed by boringssl").unwrap();
            let signature = signer.sign_to_vec().unwrap();

            algorithm
                .verify_signature(&point_bytes, b"signed by boringssl", &signature)
                .unwrap();
            assert!(
                algorithm
                    .verify_signature(&point_bytes, b"tampered", &signature)
                    .is_err()
            );

            // X.509 and TLS use the ASN.1 DER ECDSA signature form. Reject
            // trailing data and BER's non-minimal long-form length rather than
            // allowing multiple encodings of the same signature.
            let mut trailing = signature.clone();
            trailing.push(0);
            assert!(
                algorithm
                    .verify_signature(&point_bytes, b"signed by boringssl", &trailing)
                    .is_err()
            );

            assert_eq!(signature[0], 0x30);
            assert!(signature[1] < 0x80);
            let mut noncanonical_length = Vec::with_capacity(signature.len() + 1);
            noncanonical_length.extend_from_slice(&[0x30, 0x81, signature[1]]);
            noncanonical_length.extend_from_slice(&signature[2..]);
            assert!(
                algorithm
                    .verify_signature(&point_bytes, b"signed by boringssl", &noncanonical_length)
                    .is_err()
            );
        }
    }

    #[test]
    fn ecdsa_certificate_curve_digest_pairs_roundtrip_with_strict_der() {
        assert_ecdsa_roundtrips(
            Nid::X9_62_PRIME256V1,
            &[
                (ECDSA_P256_SHA256, MessageDigest::sha256()),
                (ECDSA_P256_SHA384, MessageDigest::sha384()),
                (ECDSA_P256_SHA512, MessageDigest::sha512()),
            ],
        );
        assert_ecdsa_roundtrips(
            Nid::SECP384R1,
            &[
                (ECDSA_P384_SHA256, MessageDigest::sha256()),
                (ECDSA_P384_SHA384, MessageDigest::sha384()),
                (ECDSA_P384_SHA512, MessageDigest::sha512()),
            ],
        );
    }

    #[test]
    fn ecdsa_rejects_compressed_and_hybrid_public_keys() {
        let cases = [
            (
                Nid::X9_62_PRIME256V1,
                ECDSA_P256_SHA256,
                MessageDigest::sha256(),
            ),
            (Nid::SECP384R1, ECDSA_P384_SHA384, MessageDigest::sha384()),
        ];

        for (nid, algorithm, digest) in cases {
            let group = EcGroup::from_curve_name(nid).unwrap();
            let key = EcKey::generate(&group).unwrap();
            let pkey = PKey::from_ec_key(key.clone()).unwrap();
            let mut signer = Signer::new(digest, &pkey).unwrap();
            signer.update(b"message").unwrap();
            let signature = signer.sign_to_vec().unwrap();
            let mut ctx = BigNumContext::new().unwrap();

            let compressed = key
                .public_key()
                .to_bytes(
                    &group,
                    openssl::ec::PointConversionForm::COMPRESSED,
                    &mut ctx,
                )
                .unwrap();
            assert!(
                algorithm
                    .verify_signature(&compressed, b"message", &signature)
                    .is_err()
            );

            let mut hybrid = key
                .public_key()
                .to_bytes(
                    &group,
                    openssl::ec::PointConversionForm::UNCOMPRESSED,
                    &mut ctx,
                )
                .unwrap();
            let y_lsb = hybrid[hybrid.len() - 1] & 1;
            hybrid[0] = 0x06 | y_lsb;
            assert!(
                algorithm
                    .verify_signature(&hybrid, b"message", &signature)
                    .is_err()
            );
        }
    }

    #[test]
    fn ecdsa_tls12_mapping_includes_both_certificate_curves() {
        let mapped = |scheme| {
            SUPPORTED_SIG_ALGS
                .mapping
                .iter()
                .find_map(|(candidate, algorithms)| (*candidate == scheme).then_some(*algorithms))
                .unwrap()
        };

        let sha256 = mapped(SignatureScheme::ECDSA_NISTP256_SHA256);
        assert_eq!(sha256.len(), 2);
        // TLS 1.3 uses only the first entry and requires the named curve.
        assert!(std::ptr::eq(sha256[0], ECDSA_P256_SHA256));
        assert!(
            sha256
                .iter()
                .any(|algorithm| std::ptr::eq(*algorithm, ECDSA_P256_SHA256))
        );
        assert!(
            sha256
                .iter()
                .any(|algorithm| std::ptr::eq(*algorithm, ECDSA_P384_SHA256))
        );

        let sha384 = mapped(SignatureScheme::ECDSA_NISTP384_SHA384);
        assert_eq!(sha384.len(), 2);
        assert!(std::ptr::eq(sha384[0], ECDSA_P384_SHA384));
        assert!(
            sha384
                .iter()
                .any(|algorithm| std::ptr::eq(*algorithm, ECDSA_P256_SHA384))
        );
        assert!(
            sha384
                .iter()
                .any(|algorithm| std::ptr::eq(*algorithm, ECDSA_P384_SHA384))
        );

        // SHA-512 is valid for ECDSA certificate signatures on either curve,
        // but there is no corresponding TLS 1.3 CertificateVerify scheme for
        // P-256 or P-384. Keep these in `all` and out of `mapping`.
        for certificate_algorithm in [ECDSA_P256_SHA512, ECDSA_P384_SHA512] {
            assert!(
                SUPPORTED_SIG_ALGS
                    .all
                    .iter()
                    .any(|candidate| std::ptr::eq(*candidate, certificate_algorithm))
            );
            assert!(!SUPPORTED_SIG_ALGS.mapping.iter().any(|(_, algorithms)| {
                algorithms
                    .iter()
                    .any(|candidate| std::ptr::eq(*candidate, certificate_algorithm))
            }));
        }
    }

    #[test]
    fn rsa_pkcs1_and_pss_roundtrip() {
        let rsa = Rsa::generate(2048).unwrap();
        let pkey = PKey::from_rsa(rsa.clone()).unwrap();
        let public_pkcs1 = rsa.public_key_to_der_pkcs1().unwrap();
        let cases = [
            (
                RSA_PKCS1_SHA256,
                RSA_PSS_SHA256,
                MessageDigest::sha256(),
                MessageDigest::sha384(),
            ),
            (
                RSA_PKCS1_SHA384,
                RSA_PSS_SHA384,
                MessageDigest::sha384(),
                MessageDigest::sha256(),
            ),
            (
                RSA_PKCS1_SHA512,
                RSA_PSS_SHA512,
                MessageDigest::sha512(),
                MessageDigest::sha256(),
            ),
        ];

        for (pkcs1_algorithm, pss_algorithm, digest, wrong_mgf_digest) in cases {
            let mut signer = Signer::new(digest, &pkey).unwrap();
            signer.update(b"pkcs1 message").unwrap();
            let signature = signer.sign_to_vec().unwrap();
            pkcs1_algorithm
                .verify_signature(&public_pkcs1, b"pkcs1 message", &signature)
                .unwrap();
            assert!(
                pkcs1_algorithm
                    .verify_signature(&public_pkcs1, b"other", &signature)
                    .is_err()
            );

            let mut signer = Signer::new(digest, &pkey).unwrap();
            signer.set_rsa_padding(Padding::PKCS1_PSS).unwrap();
            signer
                .set_rsa_pss_saltlen(RsaPssSaltlen::DIGEST_LENGTH)
                .unwrap();
            signer.set_rsa_mgf1_md(digest).unwrap();
            signer.update(b"pss message").unwrap();
            let signature = signer.sign_to_vec().unwrap();
            pss_algorithm
                .verify_signature(&public_pkcs1, b"pss message", &signature)
                .unwrap();
            assert!(
                pss_algorithm
                    .verify_signature(&public_pkcs1, b"other", &signature)
                    .is_err()
            );

            let mut wrong_salt_signer = Signer::new(digest, &pkey).unwrap();
            wrong_salt_signer
                .set_rsa_padding(Padding::PKCS1_PSS)
                .unwrap();
            wrong_salt_signer
                .set_rsa_pss_saltlen(RsaPssSaltlen::custom(0))
                .unwrap();
            wrong_salt_signer.set_rsa_mgf1_md(digest).unwrap();
            wrong_salt_signer.update(b"pss message").unwrap();
            let wrong_salt_signature = wrong_salt_signer.sign_to_vec().unwrap();
            assert!(
                pss_algorithm
                    .verify_signature(&public_pkcs1, b"pss message", &wrong_salt_signature)
                    .is_err()
            );

            let mut wrong_mgf_signer = Signer::new(digest, &pkey).unwrap();
            wrong_mgf_signer
                .set_rsa_padding(Padding::PKCS1_PSS)
                .unwrap();
            wrong_mgf_signer
                .set_rsa_pss_saltlen(RsaPssSaltlen::DIGEST_LENGTH)
                .unwrap();
            wrong_mgf_signer.set_rsa_mgf1_md(wrong_mgf_digest).unwrap();
            wrong_mgf_signer.update(b"pss message").unwrap();
            let wrong_mgf_signature = wrong_mgf_signer.sign_to_vec().unwrap();
            assert!(
                pss_algorithm
                    .verify_signature(&public_pkcs1, b"pss message", &wrong_mgf_signature)
                    .is_err()
            );
        }
    }

    #[test]
    fn rsa_pkcs1_accepts_absent_signature_parameters() {
        let rsa = Rsa::generate(2048).unwrap();
        let pkey = PKey::from_rsa(rsa.clone()).unwrap();
        let public_pkcs1 = rsa.public_key_to_der_pkcs1().unwrap();
        let cases: [(&dyn SignatureVerificationAlgorithm, MessageDigest, &[u8]); 3] = [
            (
                RSA_PKCS1_SHA256_ABSENT_PARAMS,
                MessageDigest::sha256(),
                &[
                    0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x0b,
                ],
            ),
            (
                RSA_PKCS1_SHA384_ABSENT_PARAMS,
                MessageDigest::sha384(),
                &[
                    0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x0c,
                ],
            ),
            (
                RSA_PKCS1_SHA512_ABSENT_PARAMS,
                MessageDigest::sha512(),
                &[
                    0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x0d,
                ],
            ),
        ];

        for (algorithm, digest, expected_alg_id) in cases {
            assert_eq!(algorithm.signature_alg_id().as_ref(), expected_alg_id);
            assert!(
                SUPPORTED_SIG_ALGS.all.iter().any(|candidate| {
                    candidate.signature_alg_id() == algorithm.signature_alg_id()
                })
            );

            let mut signer = Signer::new(digest, &pkey).unwrap();
            signer.update(b"absent parameters").unwrap();
            let signature = signer.sign_to_vec().unwrap();
            algorithm
                .verify_signature(&public_pkcs1, b"absent parameters", &signature)
                .unwrap();
        }
    }

    #[test]
    fn webpki_accepts_rsa_sha256_certificate_with_null_parameters() {
        let now = UnixTime::now();
        let issuer_key = PKey::from_rsa(Rsa::generate(2048).unwrap()).unwrap();
        let server_key = PKey::from_rsa(Rsa::generate(2048).unwrap()).unwrap();
        let (issuer, issuer_key, server) =
            server_chain(now, issuer_key, server_key, MessageDigest::sha256());
        let server_der = server.to_der().unwrap();
        let (tbs, outer_algorithm, _) = certificate_parts(&server_der);
        let (_, inner_algorithm) = tbs_signature_algorithm(tbs);
        assert_eq!(inner_algorithm, RSA_SHA256_WITH_NULL_DER);
        assert_eq!(outer_algorithm, RSA_SHA256_WITH_NULL_DER);
        assert!(server.verify(&issuer_key).unwrap());

        verify_server_path(&issuer, server_der, now);
    }

    #[test]
    fn webpki_accepts_rsa_sha256_certificate_with_absent_parameters() {
        let now = UnixTime::now();
        let issuer_key = PKey::from_rsa(Rsa::generate(2048).unwrap()).unwrap();
        let server_key = PKey::from_rsa(Rsa::generate(2048).unwrap()).unwrap();
        let (issuer, issuer_key, server) =
            server_chain(now, issuer_key, server_key, MessageDigest::sha256());
        let server_der =
            rsa_sha256_certificate_with_absent_params(&server.to_der().unwrap(), &issuer_key);

        // Assert both signature AlgorithmIdentifiers were changed: the one
        // covered by the signature in TBSCertificate and the outer copy.
        let (tbs, outer_algorithm, _) = certificate_parts(&server_der);
        let (_, inner_algorithm) = tbs_signature_algorithm(tbs);
        assert_eq!(inner_algorithm, RSA_SHA256_ABSENT_PARAMS_DER);
        assert_eq!(outer_algorithm, RSA_SHA256_ABSENT_PARAMS_DER);

        // Independently confirm the reconstructed certificate is validly
        // signed before asking rustls/WebPKI to build and validate its path.
        let parsed_server = X509::from_der(&server_der).unwrap();
        assert!(parsed_server.verify(&issuer_key).unwrap());

        verify_server_path(&issuer, server_der, now);
    }

    #[test]
    fn webpki_accepts_rsa_pss_sha256_certificate_path() {
        let now = UnixTime::now();
        let issuer_key = PKey::from_rsa(Rsa::generate(2048).unwrap()).unwrap();
        let server_key = PKey::from_rsa(Rsa::generate(2048).unwrap()).unwrap();
        let (issuer, issuer_key, server) =
            server_chain(now, issuer_key, server_key, MessageDigest::sha256());
        let server_der = rsa_sha256_certificate_with_pss(&server.to_der().unwrap(), &issuer_key);
        let expected_algorithm = der_wrap(0x30, alg_id::RSA_PSS_SHA256.as_ref());

        let (tbs, outer_algorithm, _) = certificate_parts(&server_der);
        let (_, inner_algorithm) = tbs_signature_algorithm(tbs);
        assert_eq!(inner_algorithm, expected_algorithm);
        assert_eq!(outer_algorithm, expected_algorithm);
        let parsed_server = X509::from_der(&server_der).unwrap();
        assert!(parsed_server.verify(&issuer_key).unwrap());

        verify_server_path(&issuer, server_der, now);
    }

    #[test]
    fn webpki_accepts_ecdsa_p256_certificate_path() {
        let now = UnixTime::now();
        let group = EcGroup::from_curve_name(Nid::X9_62_PRIME256V1).unwrap();
        let issuer_key = PKey::from_ec_key(EcKey::generate(&group).unwrap()).unwrap();
        let server_key = PKey::from_ec_key(EcKey::generate(&group).unwrap()).unwrap();
        let (issuer, issuer_key, server) =
            server_chain(now, issuer_key, server_key, MessageDigest::sha256());
        assert!(server.verify(&issuer_key).unwrap());

        verify_server_path(&issuer, server.to_der().unwrap(), now);
    }

    #[test]
    fn webpki_accepts_ecdsa_p384_sha384_certificate_path() {
        let now = UnixTime::now();
        let group = EcGroup::from_curve_name(Nid::SECP384R1).unwrap();
        let issuer_key = PKey::from_ec_key(EcKey::generate(&group).unwrap()).unwrap();
        let server_key = PKey::from_ec_key(EcKey::generate(&group).unwrap()).unwrap();
        let (issuer, issuer_key, server) =
            server_chain(now, issuer_key, server_key, MessageDigest::sha384());
        assert!(server.verify(&issuer_key).unwrap());

        verify_server_path(&issuer, server.to_der().unwrap(), now);
    }

    #[test]
    fn webpki_accepts_ecdsa_sha512_certificate_paths() {
        for nid in [Nid::X9_62_PRIME256V1, Nid::SECP384R1] {
            let now = UnixTime::now();
            let group = EcGroup::from_curve_name(nid).unwrap();
            let issuer_key = PKey::from_ec_key(EcKey::generate(&group).unwrap()).unwrap();
            let server_key = PKey::from_ec_key(EcKey::generate(&group).unwrap()).unwrap();
            let (issuer, issuer_key, server) =
                server_chain(now, issuer_key, server_key, MessageDigest::sha512());
            assert!(server.verify(&issuer_key).unwrap());

            verify_server_path(&issuer, server.to_der().unwrap(), now);
        }
    }

    #[test]
    fn webpki_accepts_ed25519_certificate_path() {
        let now = UnixTime::now();
        let issuer_key = PKey::generate_ed25519().unwrap();
        let server_key = PKey::generate_ed25519().unwrap();
        let (issuer, issuer_key, server) = ed25519_server_chain(now, issuer_key, server_key);
        assert!(server.verify(&issuer_key).unwrap());

        verify_server_path(&issuer, server.to_der().unwrap(), now);
    }

    /// Trailing bytes after the `RSAPublicKey` inside an SPKI are not part
    /// of any valid encoding and must not verify.
    #[test]
    fn rsa_rejects_trailing_spki_garbage() {
        let rsa = Rsa::generate(2048).unwrap();
        let pkey = PKey::from_rsa(rsa.clone()).unwrap();
        let mut public_pkcs1 = rsa.public_key_to_der_pkcs1().unwrap();

        let mut signer = Signer::new(MessageDigest::sha256(), &pkey).unwrap();
        signer.update(b"message").unwrap();
        let sig = signer.sign_to_vec().unwrap();
        RSA_PKCS1_SHA256
            .verify_signature(&public_pkcs1, b"message", &sig)
            .unwrap();

        public_pkcs1.push(0x00);
        assert!(
            RSA_PKCS1_SHA256
                .verify_signature(&public_pkcs1, b"message", &sig)
                .is_err()
        );
    }

    /// A too-small RSA key must be rejected even when its signature is
    /// otherwise valid.
    #[test]
    fn rsa_rejects_undersized_keys() {
        let rsa = Rsa::generate(1024).unwrap();
        let pkey = PKey::from_rsa(rsa.clone()).unwrap();
        let public_pkcs1 = rsa.public_key_to_der_pkcs1().unwrap();

        let mut signer = Signer::new(MessageDigest::sha256(), &pkey).unwrap();
        signer.update(b"message").unwrap();
        let sig = signer.sign_to_vec().unwrap();
        assert!(
            RSA_PKCS1_SHA256
                .verify_signature(&public_pkcs1, b"message", &sig)
                .is_err()
        );
    }

    /// The 2048..=8192 bounds are on the modulus's exact bit length. A
    /// 2047-bit modulus occupies 256 bytes, so the old `size() * 8` check
    /// would have passed it. BoringSSL cannot generate odd-sized keypairs
    /// (it rounds the requested bits down), so probe `load_key` with
    /// fabricated public moduli at the boundaries.
    #[test]
    fn rsa_key_size_bounds_are_exact() {
        let alg = BoringVerify {
            public_key_alg_id: alg_id::RSA_ENCRYPTION,
            signature_alg_id: alg_id::RSA_PKCS1_SHA256,
            kind: KeyKind::RsaPkcs1,
            digest: Some(Digest::Sha256),
        };
        let der_for_bits = |bits: i32| {
            let mut n = openssl::bn::BigNum::new().unwrap();
            n.set_bit(bits - 1).unwrap();
            n.set_bit(0).unwrap();
            let e = openssl::bn::BigNum::from_u32(65537).unwrap();
            let rsa = Rsa::from_public_components(n, e).unwrap();
            rsa.public_key_to_der_pkcs1().unwrap()
        };
        assert!(alg.load_key(&der_for_bits(2047)).is_err());
        assert!(alg.load_key(&der_for_bits(2048)).is_ok());
        assert!(alg.load_key(&der_for_bits(8192)).is_ok());
        assert!(alg.load_key(&der_for_bits(8193)).is_err());
    }
}
