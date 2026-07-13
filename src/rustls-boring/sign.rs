// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! Private key loading and TLS 1.3 handshake signing.

use std::fmt;
use std::sync::Arc;

use openssl::ec::EcKey;
use openssl::hash::MessageDigest;
use openssl::nid::Nid;
use openssl::pkey::{Id, PKey, Private};
use openssl::rsa::{Padding, Rsa};
use openssl::sign::{RsaPssSaltlen, Signer as SslSigner};
use rustls::crypto::KeyProvider;
use rustls::pki_types::{PrivateKeyDer, SubjectPublicKeyInfoDer};
use rustls::sign::{Signer, SigningKey};
use rustls::{Error, SignatureAlgorithm, SignatureScheme};
use zeroize::Zeroize;

use crate::general_error;

#[derive(Debug)]
pub(crate) struct BoringKeyProvider;

/// Hold a value containing secret material and invoke its [`Zeroize`]
/// implementation on every exit path, including errors and unwinding panics.
/// Owned buffers are wiped; immutable borrowed data remains caller-owned and
/// cannot be erased by this layer.
struct ZeroizeOnDrop<T: Zeroize>(T);

impl<T: Zeroize> Drop for ZeroizeOnDrop<T> {
    fn drop(&mut self) {
        self.0.zeroize();
    }
}

impl KeyProvider for BoringKeyProvider {
    fn load_private_key(
        &self,
        key_der: PrivateKeyDer<'static>,
    ) -> Result<Arc<dyn SigningKey>, Error> {
        // Owned `PrivateKeyDer` buffers only wipe when their `Zeroize`
        // implementation is called explicitly. Keep the value behind an RAII
        // guard while BoringSSL imports its own (independently owned)
        // representation. Borrowed static inputs are immutable and therefore
        // remain the caller's responsibility.
        let key_der = ZeroizeOnDrop(key_der);
        Ok(Arc::new(BoringSigningKey::load(&key_der.0)?))
    }
}

pub(crate) struct BoringSigningKey {
    key: Arc<PKey<Private>>,
    public_key: SubjectPublicKeyInfoDer<'static>,
    algorithm: SignatureAlgorithm,
    schemes: &'static [SignatureScheme],
}

const MIN_RSA_BITS: u32 = 2048;
const MAX_RSA_BITS: u32 = 8192;

const DER_SEQUENCE: u8 = 0x30;
const DER_INTEGER: u8 = 0x02;
const DER_OCTET_STRING: u8 = 0x04;
const DER_OBJECT_IDENTIFIER: u8 = 0x06;

// 1.2.840.113549.1.1.1 (rsaEncryption) and
// 1.2.840.113549.1.1.10 (id-RSASSA-PSS).
const RSA_ENCRYPTION_OID: &[u8] = b"\x2a\x86\x48\x86\xf7\x0d\x01\x01\x01";
const RSA_PSS_OID: &[u8] = b"\x2a\x86\x48\x86\xf7\x0d\x01\x01\x0a";

const RSA_SCHEMES: &[SignatureScheme] = &[
    SignatureScheme::RSA_PSS_SHA512,
    SignatureScheme::RSA_PSS_SHA384,
    SignatureScheme::RSA_PSS_SHA256,
    SignatureScheme::RSA_PKCS1_SHA512,
    SignatureScheme::RSA_PKCS1_SHA384,
    SignatureScheme::RSA_PKCS1_SHA256,
];

fn invalid_private_key_der(encoding: &str) -> Error {
    Error::General(format!("invalid {encoding} private key DER"))
}

/// Parse one canonically length-encoded DER element without allocating.
fn split_der_element<'a>(
    der: &'a [u8],
    expected_tag: u8,
    encoding: &str,
) -> Result<(&'a [u8], &'a [u8]), Error> {
    let invalid = || Error::General(format!("invalid {encoding} private key DER"));
    if der.first() != Some(&expected_tag) {
        return Err(invalid());
    }

    let first_len = *der.get(1).ok_or_else(&invalid)?;
    let (length_len, content_len) = if first_len & 0x80 == 0 {
        (0usize, usize::from(first_len))
    } else {
        let len_len = usize::from(first_len & 0x7f);
        if len_len == 0 || len_len > std::mem::size_of::<usize>() {
            return Err(invalid());
        }
        let len_bytes = der.get(2..2 + len_len).ok_or_else(&invalid)?;
        // DER lengths use the shortest possible encoding.
        if len_bytes.first() == Some(&0) {
            return Err(invalid());
        }
        let content_len = len_bytes.iter().try_fold(0usize, |len, &byte| {
            len.checked_mul(256)?.checked_add(usize::from(byte))
        });
        let Some(content_len) = content_len else {
            return Err(invalid());
        };
        if content_len < 128 {
            return Err(invalid());
        }
        (len_len, content_len)
    };

    let payload = der.get(2 + length_len..).ok_or_else(&invalid)?;
    let content = payload.get(..content_len).ok_or_else(&invalid)?;
    let trailing = payload.get(content_len..).ok_or_else(&invalid)?;
    Ok((content, trailing))
}

fn take_der_element<'a>(
    der: &mut &'a [u8],
    expected_tag: u8,
    encoding: &str,
) -> Result<&'a [u8], Error> {
    let (content, trailing) = split_der_element(der, expected_tag, encoding)?;
    *der = trailing;
    Ok(content)
}

/// Require exactly one canonically length-encoded DER SEQUENCE. OpenSSL's
/// `d2i_*` compatibility APIs deliberately accept a valid prefix and advance
/// their input pointer past it; the Rust bindings discard that pointer, so do
/// the whole-input check before handing private keys to those APIs.
fn complete_der_sequence_content<'a>(der: &'a [u8], encoding: &str) -> Result<&'a [u8], Error> {
    let (content, trailing) = split_der_element(der, DER_SEQUENCE, encoding)?;
    if !trailing.is_empty() {
        return Err(invalid_private_key_der(encoding));
    }
    Ok(content)
}

fn check_complete_der_sequence(der: &[u8], encoding: &str) -> Result<(), Error> {
    complete_der_sequence_content(der, encoding).map(|_| ())
}

fn rsa_modulus_bits(integer: &[u8], encoding: &str) -> Result<usize, Error> {
    let invalid = || invalid_private_key_der(encoding);
    let first = *integer.first().ok_or_else(&invalid)?;
    let magnitude = if first == 0 {
        // A zero prefix is required exactly when the magnitude's high bit is
        // set. Reject zero and non-minimal positive INTEGER encodings.
        if integer.len() == 1 || integer[1] & 0x80 == 0 {
            return Err(invalid());
        }
        &integer[1..]
    } else {
        // RSA's modulus is positive, so an unprefixed high bit is invalid.
        if first & 0x80 != 0 {
            return Err(invalid());
        }
        integer
    };

    let high_bits = 8usize - magnitude[0].leading_zeros() as usize;
    magnitude
        .len()
        .checked_sub(1)
        .and_then(|bytes| bytes.checked_mul(8))
        .and_then(|bits| bits.checked_add(high_bits))
        .ok_or_else(invalid)
}

fn check_rsa_bits_before_import(bits: usize) -> Result<(), Error> {
    if !((MIN_RSA_BITS as usize)..=(MAX_RSA_BITS as usize)).contains(&bits) {
        return Err(Error::General(format!(
            "unsupported RSA key size: {bits} bits (expected {MIN_RSA_BITS}..={MAX_RSA_BITS})"
        )));
    }
    Ok(())
}

/// Inspect a PKCS#1 key's modulus before BoringSSL parses or validates any of
/// its expensive private components. BoringSSL supports RSA-16384, while this
/// provider intentionally caps keys at RSA-8192.
fn check_pkcs1_rsa_size_before_import(der: &[u8], encoding: &str) -> Result<(), Error> {
    let mut fields = complete_der_sequence_content(der, encoding)?;
    if take_der_element(&mut fields, DER_INTEGER, encoding)? != [0] {
        return Err(invalid_private_key_der(encoding));
    }
    let modulus = take_der_element(&mut fields, DER_INTEGER, encoding)?;
    check_rsa_bits_before_import(rsa_modulus_bits(modulus, encoding)?)
}

/// If a PKCS#8 PrivateKeyInfo identifies an RSA or RSA-PSS key, find the
/// embedded PKCS#1 modulus and enforce our size policy before BoringSSL import.
fn check_pkcs8_rsa_size_before_import(der: &[u8]) -> Result<(), Error> {
    let encoding = "pkcs8";
    let mut fields = complete_der_sequence_content(der, encoding)?;
    if take_der_element(&mut fields, DER_INTEGER, encoding)? != [0] {
        return Err(invalid_private_key_der(encoding));
    }

    let mut algorithm = take_der_element(&mut fields, DER_SEQUENCE, encoding)?;
    let oid = take_der_element(&mut algorithm, DER_OBJECT_IDENTIFIER, encoding)?;
    if oid != RSA_ENCRYPTION_OID && oid != RSA_PSS_OID {
        return Ok(());
    }

    let private_key = take_der_element(&mut fields, DER_OCTET_STRING, encoding)?;
    check_pkcs1_rsa_size_before_import(private_key, encoding)
}

fn check_rsa_bits(bits: u32) -> Result<(), Error> {
    if !(MIN_RSA_BITS..=MAX_RSA_BITS).contains(&bits) {
        return Err(Error::General(format!(
            "unsupported RSA key size: {bits} bits (expected {MIN_RSA_BITS}..={MAX_RSA_BITS})"
        )));
    }
    Ok(())
}

impl BoringSigningKey {
    fn load(key_der: &PrivateKeyDer<'_>) -> Result<Self, Error> {
        let key = match key_der {
            PrivateKeyDer::Pkcs8(der) => {
                let der = der.secret_pkcs8_der();
                check_pkcs8_rsa_size_before_import(der)?;
                PKey::private_key_from_pkcs8(der).map_err(|e| general_error("pkcs8 parse", e))?
            }
            PrivateKeyDer::Sec1(der) => {
                let der = der.secret_sec1_der();
                check_complete_der_sequence(der, "sec1")?;
                let ec =
                    EcKey::private_key_from_der(der).map_err(|e| general_error("sec1 parse", e))?;
                PKey::from_ec_key(ec).map_err(|e| general_error("ec to pkey", e))?
            }
            PrivateKeyDer::Pkcs1(der) => {
                let der = der.secret_pkcs1_der();
                check_pkcs1_rsa_size_before_import(der, "pkcs1")?;
                let rsa =
                    Rsa::private_key_from_der(der).map_err(|e| general_error("pkcs1 parse", e))?;
                PKey::from_rsa(rsa).map_err(|e| general_error("rsa to pkey", e))?
            }
            _ => return Err(Error::General("unhandled private key encoding".into())),
        };
        Self::from_pkey(key)
    }

    pub(crate) fn from_pkey(key: PKey<Private>) -> Result<Self, Error> {
        let (algorithm, schemes): (_, &'static [SignatureScheme]) = match key.id() {
            Id::ED25519 => (SignatureAlgorithm::ED25519, &[SignatureScheme::ED25519]),
            Id::EC => {
                let curve = key.ec_key().ok().and_then(|ec| ec.group().curve_name());
                match curve {
                    Some(Nid::X9_62_PRIME256V1) => (
                        SignatureAlgorithm::ECDSA,
                        &[SignatureScheme::ECDSA_NISTP256_SHA256][..],
                    ),
                    Some(Nid::SECP384R1) => (
                        SignatureAlgorithm::ECDSA,
                        &[SignatureScheme::ECDSA_NISTP384_SHA384][..],
                    ),
                    _ => return Err(Error::General("unsupported ECDSA curve".into())),
                }
            }
            Id::RSA => {
                // Besides matching WebPKI's policy, the lower bound guarantees
                // every advertised PSS/digest combination fits the modulus.
                check_rsa_bits(key.bits())?;
                (
                    SignatureAlgorithm::RSA,
                    // TLS 1.3 requires PSS; PKCS#1 remains for 1.2 peers.
                    RSA_SCHEMES,
                )
            }
            _ => return Err(Error::General("unsupported private key type".into())),
        };
        let public_key = key
            .public_key_to_der()
            .map(SubjectPublicKeyInfoDer::from)
            .map_err(|e| general_error("public key DER", e))?;
        Ok(Self {
            key: Arc::new(key),
            public_key,
            algorithm,
            schemes,
        })
    }
}

impl fmt::Debug for BoringSigningKey {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("BoringSigningKey")
            .field("algorithm", &self.algorithm)
            .finish_non_exhaustive()
    }
}

impl SigningKey for BoringSigningKey {
    fn choose_scheme(&self, offered: &[SignatureScheme]) -> Option<Box<dyn Signer>> {
        let scheme = self.schemes.iter().find(|s| offered.contains(s))?;
        Some(Box::new(BoringSigner {
            key: self.key.clone(),
            scheme: *scheme,
        }))
    }

    fn algorithm(&self) -> SignatureAlgorithm {
        self.algorithm
    }

    fn public_key(&self) -> Option<SubjectPublicKeyInfoDer<'_>> {
        Some(SubjectPublicKeyInfoDer::from(self.public_key.as_ref()))
    }
}

struct BoringSigner {
    key: Arc<PKey<Private>>,
    scheme: SignatureScheme,
}

impl fmt::Debug for BoringSigner {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("BoringSigner")
            .field("scheme", &self.scheme)
            .finish_non_exhaustive()
    }
}

impl Signer for BoringSigner {
    fn sign(&self, message: &[u8]) -> Result<Vec<u8>, Error> {
        let fail = |e| general_error("sign", e);
        match self.scheme {
            SignatureScheme::ED25519 => {
                let mut signer = SslSigner::new_without_digest(&self.key).map_err(fail)?;
                signer.sign_oneshot_to_vec(message).map_err(fail)
            }
            SignatureScheme::ECDSA_NISTP256_SHA256 => {
                self.sign_with_md(message, MessageDigest::sha256(), None)
            }
            SignatureScheme::ECDSA_NISTP384_SHA384 => {
                self.sign_with_md(message, MessageDigest::sha384(), None)
            }
            SignatureScheme::RSA_PSS_SHA256 => {
                self.sign_with_md(message, MessageDigest::sha256(), Some(Padding::PKCS1_PSS))
            }
            SignatureScheme::RSA_PSS_SHA384 => {
                self.sign_with_md(message, MessageDigest::sha384(), Some(Padding::PKCS1_PSS))
            }
            SignatureScheme::RSA_PSS_SHA512 => {
                self.sign_with_md(message, MessageDigest::sha512(), Some(Padding::PKCS1_PSS))
            }
            SignatureScheme::RSA_PKCS1_SHA256 => {
                self.sign_with_md(message, MessageDigest::sha256(), Some(Padding::PKCS1))
            }
            SignatureScheme::RSA_PKCS1_SHA384 => {
                self.sign_with_md(message, MessageDigest::sha384(), Some(Padding::PKCS1))
            }
            SignatureScheme::RSA_PKCS1_SHA512 => {
                self.sign_with_md(message, MessageDigest::sha512(), Some(Padding::PKCS1))
            }
            _ => Err(Error::General("unsupported signature scheme".into())),
        }
    }

    fn scheme(&self) -> SignatureScheme {
        self.scheme
    }
}

impl BoringSigner {
    fn sign_with_md(
        &self,
        message: &[u8],
        md: MessageDigest,
        rsa_padding: Option<Padding>,
    ) -> Result<Vec<u8>, Error> {
        let fail = |e| general_error("sign", e);
        let mut signer = SslSigner::new(md, &self.key).map_err(fail)?;
        if let Some(padding) = rsa_padding {
            signer.set_rsa_padding(padding).map_err(fail)?;
            if padding == Padding::PKCS1_PSS {
                signer
                    .set_rsa_pss_saltlen(RsaPssSaltlen::DIGEST_LENGTH)
                    .map_err(fail)?;
                signer.set_rsa_mgf1_md(md).map_err(fail)?;
            }
        }
        signer.update(message).map_err(fail)?;
        signer.sign_to_vec().map_err(fail)
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};

    use openssl::asn1::Asn1Time;
    use openssl::bn::{BigNum, BigNumContext};
    use openssl::ec::{EcGroup, PointConversionForm};
    use openssl::x509::{X509, X509NameBuilder};
    use rustls::InconsistentKeys;
    use rustls::pki_types::{
        CertificateDer, PrivatePkcs1KeyDer, PrivatePkcs8KeyDer, PrivateSec1KeyDer,
        SignatureVerificationAlgorithm,
    };
    use rustls::sign::CertifiedKey;

    use super::*;
    use crate::verify;

    fn ec_key(nid: Nid) -> PKey<Private> {
        let group = EcGroup::from_curve_name(nid).unwrap();
        PKey::from_ec_key(EcKey::generate(&group).unwrap()).unwrap()
    }

    fn self_signed_cert(key: &PKey<Private>) -> CertificateDer<'static> {
        let mut name = X509NameBuilder::new().unwrap();
        name.append_entry_by_text("CN", "rustls-boring test")
            .unwrap();
        let name = name.build();
        let serial = BigNum::from_u32(1).unwrap().to_asn1_integer().unwrap();
        let not_before = Asn1Time::days_from_now(0).unwrap();
        let not_after = Asn1Time::days_from_now(1).unwrap();

        let mut cert = X509::builder().unwrap();
        cert.set_version(2).unwrap();
        cert.set_serial_number(&serial).unwrap();
        cert.set_subject_name(&name).unwrap();
        cert.set_issuer_name(&name).unwrap();
        cert.set_not_before(&not_before).unwrap();
        cert.set_not_after(&not_after).unwrap();
        cert.set_pubkey(key).unwrap();
        cert.sign(key, MessageDigest::sha256()).unwrap();
        CertificateDer::from(cert.build().to_der().unwrap())
    }

    fn verifier_for_scheme(scheme: SignatureScheme) -> &'static dyn SignatureVerificationAlgorithm {
        match scheme {
            SignatureScheme::RSA_PSS_SHA512 => verify::RSA_PSS_SHA512,
            SignatureScheme::RSA_PSS_SHA384 => verify::RSA_PSS_SHA384,
            SignatureScheme::RSA_PSS_SHA256 => verify::RSA_PSS_SHA256,
            SignatureScheme::RSA_PKCS1_SHA512 => verify::RSA_PKCS1_SHA512,
            SignatureScheme::RSA_PKCS1_SHA384 => verify::RSA_PKCS1_SHA384,
            SignatureScheme::RSA_PKCS1_SHA256 => verify::RSA_PKCS1_SHA256,
            _ => unreachable!("non-RSA test scheme"),
        }
    }

    fn assert_tampering_rejected(
        verifier: &dyn SignatureVerificationAlgorithm,
        public_key: &[u8],
        signature: &[u8],
    ) {
        assert!(
            verifier
                .verify_signature(public_key, b"different message", signature)
                .is_err()
        );

        let mut tampered_signature = signature.to_vec();
        *tampered_signature.last_mut().expect("non-empty signature") ^= 1;
        assert!(
            verifier
                .verify_signature(public_key, b"message", &tampered_signature)
                .is_err()
        );
    }

    fn structurally_invalid_rsa_with_bits(bits: u32) -> Rsa<Private> {
        assert!(bits > 0);
        let mut modulus = vec![0u8; bits.div_ceil(8) as usize];
        modulus[0] = 1 << ((bits - 1) % 8);
        *modulus.last_mut().unwrap() |= 1;

        let one = || BigNum::from_u32(1).unwrap();
        Rsa::from_private_components(
            BigNum::from_slice(&modulus).unwrap(),
            BigNum::from_u32(65_537).unwrap(),
            one(),
            one(),
            one(),
            one(),
            one(),
            one(),
        )
        .unwrap()
    }

    fn assert_oversized_preflight_error(key: &PrivateKeyDer<'_>, bits: u32) {
        let error = BoringSigningKey::load(key).unwrap_err();
        assert!(matches!(
            error,
            Error::General(message)
                if message == format!(
                    "unsupported RSA key size: {bits} bits (expected {MIN_RSA_BITS}..={MAX_RSA_BITS})"
                )
        ));
    }

    struct WipeProbe(Arc<AtomicUsize>);

    impl Zeroize for WipeProbe {
        fn zeroize(&mut self) {
            self.0.fetch_add(1, Ordering::SeqCst);
        }
    }

    #[test]
    fn ed25519_pkcs8_load_sign_verify() {
        let key = PKey::generate_ed25519().unwrap();
        let pkcs8 = key.private_key_to_pkcs8().unwrap();
        let der = PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(pkcs8));

        let signing_key = BoringKeyProvider.load_private_key(der).unwrap();
        assert_eq!(signing_key.algorithm(), SignatureAlgorithm::ED25519);

        let signer = signing_key
            .choose_scheme(&[SignatureScheme::ED25519])
            .expect("ed25519 offered");
        assert_eq!(signer.scheme(), SignatureScheme::ED25519);
        let sig = signer.sign(b"message").unwrap();

        let raw_pub = key.raw_public_key().unwrap();
        verify::ED25519
            .verify_signature(&raw_pub, b"message", &sig)
            .unwrap();
        assert_tampering_rejected(verify::ED25519, &raw_pub, &sig);
    }

    #[test]
    fn public_key_returns_spki_for_every_supported_key_type() {
        let keys = [
            PKey::generate_ed25519().unwrap(),
            ec_key(Nid::X9_62_PRIME256V1),
            ec_key(Nid::SECP384R1),
            PKey::from_rsa(Rsa::generate(MIN_RSA_BITS).unwrap()).unwrap(),
        ];

        for key in keys {
            let expected = key.public_key_to_der().unwrap();
            let signing_key = BoringSigningKey::from_pkey(key).unwrap();
            assert_eq!(signing_key.public_key().unwrap().as_ref(), expected);
        }
    }

    #[test]
    fn certified_key_rejects_mismatched_private_key() {
        let cert_key = ec_key(Nid::X9_62_PRIME256V1);
        let cert = self_signed_cert(&cert_key);
        let matching_key = PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(
            cert_key.private_key_to_pkcs8().unwrap(),
        ));
        CertifiedKey::from_der(vec![cert.clone()], matching_key, &crate::provider()).unwrap();

        let other_key = ec_key(Nid::X9_62_PRIME256V1);
        let other_key = PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(
            other_key.private_key_to_pkcs8().unwrap(),
        ));
        let error = CertifiedKey::from_der(vec![cert], other_key, &crate::provider()).unwrap_err();
        assert!(matches!(
            error,
            Error::InconsistentKeys(InconsistentKeys::KeyMismatch)
        ));
    }

    #[test]
    fn rsa_size_policy_rejects_weak_keys_and_covers_boundaries() {
        assert!(check_rsa_bits(MIN_RSA_BITS - 1).is_err());
        assert!(check_rsa_bits(MIN_RSA_BITS).is_ok());
        assert!(check_rsa_bits(MAX_RSA_BITS).is_ok());
        assert!(check_rsa_bits(MAX_RSA_BITS + 1).is_err());

        let weak = PKey::from_rsa(Rsa::generate(1024).unwrap()).unwrap();
        let error = BoringSigningKey::from_pkey(weak).unwrap_err();
        assert!(matches!(
            error,
            Error::General(message) if message.contains("1024 bits")
        ));

        let accepted = PKey::from_rsa(Rsa::generate(MIN_RSA_BITS).unwrap()).unwrap();
        assert!(BoringSigningKey::from_pkey(accepted).is_ok());
    }

    #[test]
    fn oversized_rsa_is_rejected_before_pkcs1_or_pkcs8_import() {
        let bits = MAX_RSA_BITS + 1;
        // Constructing inconsistent components is intentional: serialization
        // is cheap, while BoringSSL import would proceed into private-key
        // validation if the modulus preflight were absent.
        let rsa = structurally_invalid_rsa_with_bits(bits);
        let pkcs1 =
            PrivateKeyDer::Pkcs1(PrivatePkcs1KeyDer::from(rsa.private_key_to_der().unwrap()));
        assert_oversized_preflight_error(&pkcs1, bits);

        let pkey = PKey::from_rsa(rsa).unwrap();
        let pkcs8_der = pkey.private_key_to_pkcs8().unwrap();
        let pkcs8 = PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(pkcs8_der.clone()));
        assert_oversized_preflight_error(&pkcs8, bits);

        // The unsupported RSA-PSS key type must receive the same pre-import
        // size defense. Changing the OID is sufficient for this preflight
        // test; BoringSSL never gets far enough to inspect PSS parameters.
        let mut pss_pkcs8_der = pkcs8_der;
        let oid = pss_pkcs8_der
            .windows(RSA_ENCRYPTION_OID.len())
            .position(|window| window == RSA_ENCRYPTION_OID)
            .expect("rsaEncryption OID");
        pss_pkcs8_der[oid + RSA_ENCRYPTION_OID.len() - 1] = 0x0a;
        let pss_pkcs8 = PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(pss_pkcs8_der));
        assert_oversized_preflight_error(&pss_pkcs8, bits);
    }

    #[test]
    fn unsupported_private_key_type_and_curve_are_rejected() {
        let cases = [
            (ec_key(Nid::SECP521R1), "unsupported ECDSA curve"),
            (
                PKey::generate_x25519().unwrap(),
                "unsupported private key type",
            ),
        ];

        for (key, expected) in cases {
            let der = PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(
                key.private_key_to_pkcs8().unwrap(),
            ));
            assert!(matches!(
                BoringSigningKey::load(&der),
                Err(Error::General(message)) if message == expected
            ));
        }
    }

    #[test]
    fn rsa_all_advertised_schemes_sign_and_verify() {
        let rsa = Rsa::generate(MIN_RSA_BITS).unwrap();
        let public_key = rsa.public_key_to_der_pkcs1().unwrap();
        let rsa = PKey::from_rsa(rsa).unwrap();
        let rsa = PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(
            rsa.private_key_to_pkcs8().unwrap(),
        ));
        let signing_key = BoringSigningKey::load(&rsa).unwrap();

        let preferred = signing_key
            .choose_scheme(&[
                SignatureScheme::RSA_PKCS1_SHA256,
                SignatureScheme::RSA_PSS_SHA256,
                SignatureScheme::RSA_PSS_SHA512,
            ])
            .expect("at least one RSA scheme offered");
        assert_eq!(preferred.scheme(), SignatureScheme::RSA_PSS_SHA512);

        for &scheme in RSA_SCHEMES {
            let signer = signing_key
                .choose_scheme(&[scheme])
                .expect("advertised RSA scheme");
            assert_eq!(signer.scheme(), scheme);
            let signature = signer.sign(b"message").unwrap();
            verifier_for_scheme(scheme)
                .verify_signature(&public_key, b"message", &signature)
                .unwrap();
            assert_tampering_rejected(verifier_for_scheme(scheme), &public_key, &signature);
        }
    }

    #[test]
    fn ecdsa_all_advertised_schemes_sign_and_verify() {
        let cases: &[(Nid, SignatureScheme, &dyn SignatureVerificationAlgorithm)] = &[
            (
                Nid::X9_62_PRIME256V1,
                SignatureScheme::ECDSA_NISTP256_SHA256,
                verify::ECDSA_P256_SHA256,
            ),
            (
                Nid::SECP384R1,
                SignatureScheme::ECDSA_NISTP384_SHA384,
                verify::ECDSA_P384_SHA384,
            ),
        ];

        for &(nid, scheme, verifier) in cases {
            let group = EcGroup::from_curve_name(nid).unwrap();
            let ec = EcKey::generate(&group).unwrap();
            let mut ctx = BigNumContext::new().unwrap();
            let public_key = ec
                .public_key()
                .to_bytes(&group, PointConversionForm::UNCOMPRESSED, &mut ctx)
                .unwrap();
            let signing_key = BoringSigningKey::from_pkey(PKey::from_ec_key(ec).unwrap()).unwrap();
            let signer = signing_key
                .choose_scheme(&[scheme])
                .expect("advertised ECDSA scheme");
            assert_eq!(signer.scheme(), scheme);
            let signature = signer.sign(b"message").unwrap();
            verifier
                .verify_signature(&public_key, b"message", &signature)
                .unwrap();
            assert_tampering_rejected(verifier, &public_key, &signature);
        }
    }

    #[test]
    fn pkcs1_and_sec1_loaders_produce_usable_signers() {
        let rsa = Rsa::generate(MIN_RSA_BITS).unwrap();
        let rsa_public = rsa.public_key_to_der_pkcs1().unwrap();
        let rsa_der =
            PrivateKeyDer::Pkcs1(PrivatePkcs1KeyDer::from(rsa.private_key_to_der().unwrap()));
        let rsa_key = BoringSigningKey::load(&rsa_der).unwrap();
        let rsa_signer = rsa_key
            .choose_scheme(&[SignatureScheme::RSA_PSS_SHA256])
            .unwrap();
        let rsa_signature = rsa_signer.sign(b"message").unwrap();
        verify::RSA_PSS_SHA256
            .verify_signature(&rsa_public, b"message", &rsa_signature)
            .unwrap();

        let group = EcGroup::from_curve_name(Nid::X9_62_PRIME256V1).unwrap();
        let ec = EcKey::generate(&group).unwrap();
        let mut ctx = BigNumContext::new().unwrap();
        let ec_public = ec
            .public_key()
            .to_bytes(&group, PointConversionForm::UNCOMPRESSED, &mut ctx)
            .unwrap();
        let ec_der = PrivateKeyDer::Sec1(PrivateSec1KeyDer::from(ec.private_key_to_der().unwrap()));
        let ec_key = BoringSigningKey::load(&ec_der).unwrap();
        let ec_signer = ec_key
            .choose_scheme(&[SignatureScheme::ECDSA_NISTP256_SHA256])
            .unwrap();
        let ec_signature = ec_signer.sign(b"message").unwrap();
        verify::ECDSA_P256_SHA256
            .verify_signature(&ec_public, b"message", &ec_signature)
            .unwrap();
    }

    #[test]
    fn private_key_loaders_reject_trailing_der() {
        let ed25519 = PKey::generate_ed25519().unwrap();
        let pkcs8 = ed25519.private_key_to_pkcs8().unwrap();
        let valid = PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(pkcs8.clone()));
        BoringSigningKey::load(&valid).unwrap();
        let mut trailing = pkcs8;
        trailing.push(0);
        let trailing = PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(trailing));
        assert!(BoringSigningKey::load(&trailing).is_err());

        let group = EcGroup::from_curve_name(Nid::X9_62_PRIME256V1).unwrap();
        let sec1 = EcKey::generate(&group)
            .unwrap()
            .private_key_to_der()
            .unwrap();
        let valid = PrivateKeyDer::Sec1(PrivateSec1KeyDer::from(sec1.clone()));
        BoringSigningKey::load(&valid).unwrap();
        let mut trailing = sec1;
        trailing.push(0);
        let trailing = PrivateKeyDer::Sec1(PrivateSec1KeyDer::from(trailing));
        assert!(BoringSigningKey::load(&trailing).is_err());

        let pkcs1 = Rsa::generate(MIN_RSA_BITS)
            .unwrap()
            .private_key_to_der()
            .unwrap();
        let valid = PrivateKeyDer::Pkcs1(PrivatePkcs1KeyDer::from(pkcs1.clone()));
        BoringSigningKey::load(&valid).unwrap();
        let mut trailing = pkcs1;
        trailing.push(0);
        let trailing = PrivateKeyDer::Pkcs1(PrivatePkcs1KeyDer::from(trailing));
        assert!(BoringSigningKey::load(&trailing).is_err());
    }

    #[test]
    fn private_key_der_envelope_rejects_noncanonical_lengths() {
        assert!(check_complete_der_sequence(&[0x30, 0x80], "test").is_err());
        assert!(check_complete_der_sequence(&[0x30, 0x81, 0x00], "test").is_err());
        assert!(check_complete_der_sequence(&[0x30, 0x81, 0x7f], "test").is_err());
        assert!(check_complete_der_sequence(&[0x30, 0x01, 0x00], "test").is_ok());
    }

    #[test]
    fn rsa_preflight_rejects_invalid_integer_encodings() {
        assert!(rsa_modulus_bits(&[], "test").is_err());
        assert!(rsa_modulus_bits(&[0], "test").is_err());
        assert!(rsa_modulus_bits(&[0, 0x7f], "test").is_err());
        assert!(rsa_modulus_bits(&[0x80], "test").is_err());
        assert_eq!(rsa_modulus_bits(&[0x7f], "test").unwrap(), 7);
        assert_eq!(rsa_modulus_bits(&[0, 0x80], "test").unwrap(), 8);
    }

    #[test]
    fn zeroize_guard_runs_on_normal_and_error_returns() {
        let normal_calls = Arc::new(AtomicUsize::new(0));
        drop(ZeroizeOnDrop(WipeProbe(normal_calls.clone())));
        assert_eq!(normal_calls.load(Ordering::SeqCst), 1);

        fn return_error(calls: Arc<AtomicUsize>) -> Result<(), ()> {
            let _guard = ZeroizeOnDrop(WipeProbe(calls));
            Err(())
        }

        let error_calls = Arc::new(AtomicUsize::new(0));
        let result = return_error(error_calls.clone());
        assert!(result.is_err());
        assert_eq!(error_calls.load(Ordering::SeqCst), 1);
    }

    // This repository's normal Buck test profile aborts on panic, so exercise
    // the unwind path only in builds where Rust can actually unwind.
    #[cfg(panic = "unwind")]
    #[test]
    fn zeroize_guard_runs_on_unwind() {
        let calls = Arc::new(AtomicUsize::new(0));
        let result = std::panic::catch_unwind({
            let calls = calls.clone();
            move || {
                let _guard = ZeroizeOnDrop(WipeProbe(calls));
                panic!("exercise unwind cleanup");
            }
        });
        assert!(result.is_err());
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn choose_scheme_respects_offer() {
        let key = PKey::generate_ed25519().unwrap();
        let signing_key = BoringSigningKey::from_pkey(key).unwrap();
        assert!(
            signing_key
                .choose_scheme(&[SignatureScheme::RSA_PSS_SHA256])
                .is_none()
        );
    }
}
