// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! TLS 1.3 key exchange: the X25519MLKEM768 post-quantum hybrid, and
//! classical X25519 and NIST P-256/P-384 ECDHE.

use openssl::bn::BigNumContext;
use openssl::derive::Deriver;
use openssl::ec::{EcGroup, EcKey, EcPoint, PointConversionForm};
use openssl::nid::Nid;
use openssl::pkey::{Id, PKey, Private};
use rustls::crypto::{ActiveKeyExchange, CompletedKeyExchange, SharedSecret, SupportedKxGroup};
use rustls::{Error, NamedGroup, ProtocolVersion};

use crate::{general_error, mlkem};

/// The hybrid group leads: rustls clients send a key share for the first
/// group, and `ActiveKeyExchange::hybrid_component` makes them append the
/// embedded X25519 share too, so classical-only servers still get a
/// retry-free handshake.
pub(crate) static ALL_KX_GROUPS: &[&dyn SupportedKxGroup] =
    &[&X25519MLKEM768, &X25519, &SECP256R1, &SECP384R1];

#[derive(Debug)]
pub(crate) struct X25519;

impl SupportedKxGroup for X25519 {
    fn name(&self) -> NamedGroup {
        NamedGroup::X25519
    }

    fn start(&self) -> Result<Box<dyn ActiveKeyExchange>, Error> {
        let key = PKey::generate_x25519().map_err(|e| general_error("x25519 keygen", e))?;
        X25519Active::from_pkey(key).map(|kx| Box::new(kx) as Box<dyn ActiveKeyExchange>)
    }
}

struct X25519Active {
    key: PKey<Private>,
    pub_bytes: Vec<u8>,
}

impl X25519Active {
    fn from_pkey(key: PKey<Private>) -> Result<Self, Error> {
        let pub_bytes = key
            .raw_public_key()
            .map_err(|e| general_error("x25519 public key", e))?;
        Ok(Self { key, pub_bytes })
    }
}

impl ActiveKeyExchange for X25519Active {
    fn complete(self: Box<Self>, peer_pub_key: &[u8]) -> Result<SharedSecret, Error> {
        let mut secret = vec![0u8; X25519_LEN];
        if let Err(e) = x25519_derive_into(&self.key, peer_pub_key, &mut secret) {
            crate::cleanse(&mut secret);
            return Err(e);
        }
        // Transfer ownership so there is no second copy of the secret.
        Ok(SharedSecret::from(secret))
    }

    fn pub_key(&self) -> &[u8] {
        &self.pub_bytes
    }

    fn group(&self) -> NamedGroup {
        NamedGroup::X25519
    }
}

const X25519_LEN: usize = 32;

/// Derive the X25519 shared secret between `key` and a peer's raw public
/// key into `out`, which must be exactly [`X25519_LEN`] bytes.
///
/// RFC 7748: reject the all-zero output produced by low-order points.
/// BoringSSL's `X25519()` already fails the derive on that output, so the
/// explicit check is defense-in-depth; `CRYPTO_memcmp` keeps it
/// constant-time rather than leaking the offset of the first nonzero byte,
/// and an unexpected secret length fails closed. Callers cleanse their
/// buffer on error.
fn x25519_derive_into(
    key: &PKey<Private>,
    peer_pub_key: &[u8],
    out: &mut [u8],
) -> Result<(), Error> {
    let invalid = || Error::from(rustls::PeerMisbehaved::InvalidKeyShare);
    let peer = PKey::public_key_from_raw_bytes(peer_pub_key, Id::X25519).map_err(|_| invalid())?;
    let mut deriver = Deriver::new(key).map_err(|e| general_error("x25519 derive", e))?;
    deriver.set_peer(&peer).map_err(|_| invalid())?;
    let written = deriver.derive(out).map_err(|_| invalid())?;
    let zeros = [0u8; X25519_LEN];
    if written != X25519_LEN || out.len() != X25519_LEN || openssl::memcmp::eq(out, &zeros) {
        return Err(invalid());
    }
    Ok(())
}

macro_rules! nist_group {
    ($ty:ident, $active:ident, $nid:expr, $group:expr, $encoded_len:expr, $secret_len:expr) => {
        #[derive(Debug)]
        pub(crate) struct $ty;

        impl SupportedKxGroup for $ty {
            fn name(&self) -> NamedGroup {
                $group
            }

            fn start(&self) -> Result<Box<dyn ActiveKeyExchange>, Error> {
                let ec_group =
                    EcGroup::from_curve_name($nid).map_err(|e| general_error("ec group", e))?;
                let ec_key =
                    EcKey::generate(&ec_group).map_err(|e| general_error("ec keygen", e))?;
                Ok(Box::new($active::new(ec_group, ec_key)?))
            }
        }

        struct $active {
            group: EcGroup,
            key: PKey<Private>,
            pub_bytes: Vec<u8>,
        }

        impl $active {
            fn new(group: EcGroup, ec_key: EcKey<Private>) -> Result<Self, Error> {
                let mut ctx = BigNumContext::new().map_err(|e| general_error("bn ctx", e))?;
                let pub_bytes = ec_key
                    .public_key()
                    .to_bytes(&group, PointConversionForm::UNCOMPRESSED, &mut ctx)
                    .map_err(|e| general_error("ec public key", e))?;
                let key = PKey::from_ec_key(ec_key).map_err(|e| general_error("ec to pkey", e))?;
                Ok(Self {
                    group,
                    key,
                    pub_bytes,
                })
            }
        }

        impl ActiveKeyExchange for $active {
            fn complete(self: Box<Self>, peer_pub_key: &[u8]) -> Result<SharedSecret, Error> {
                ecdh_complete(
                    &self.group,
                    &self.key,
                    peer_pub_key,
                    $encoded_len,
                    $secret_len,
                )
            }

            fn pub_key(&self) -> &[u8] {
                &self.pub_bytes
            }

            fn group(&self) -> NamedGroup {
                $group
            }
        }
    };
}

nist_group!(
    SECP256R1,
    P256Active,
    Nid::X9_62_PRIME256V1,
    NamedGroup::secp256r1,
    65,
    32
);
nist_group!(
    SECP384R1,
    P384Active,
    Nid::SECP384R1,
    NamedGroup::secp384r1,
    97,
    48
);

fn ecdh_complete(
    group: &EcGroup,
    key: &PKey<Private>,
    peer_pub_key: &[u8],
    encoded_len: usize,
    secret_len: usize,
) -> Result<SharedSecret, Error> {
    let invalid = || Error::from(rustls::PeerMisbehaved::InvalidKeyShare);
    // RFC 8446 section 4.2.8.2 requires the legacy uncompressed format,
    // including its exact, curve-specific length.  EC_POINT_oct2point also
    // accepts compressed encodings, so enforce the TLS representation first.
    if peer_pub_key.len() != encoded_len || peer_pub_key.first() != Some(&0x04) {
        return Err(invalid());
    }
    let mut ctx = BigNumContext::new().map_err(|e| general_error("bn ctx", e))?;
    // EC_POINT_oct2point validates that the point is on the curve.
    let point = EcPoint::from_bytes(group, peer_pub_key, &mut ctx).map_err(|_| invalid())?;
    let peer_ec = EcKey::from_public_key(group, &point).map_err(|_| invalid())?;
    peer_ec.check_key().map_err(|_| invalid())?;
    let peer = PKey::from_ec_key(peer_ec).map_err(|_| invalid())?;
    let mut deriver = Deriver::new(key).map_err(|e| general_error("ecdh derive", e))?;
    deriver.set_peer(&peer).map_err(|_| invalid())?;
    let mut secret = vec![0u8; secret_len];
    let written = match deriver.derive(&mut secret) {
        Ok(written) => written,
        Err(_) => {
            crate::cleanse(&mut secret);
            return Err(invalid());
        }
    };
    if written != secret_len {
        crate::cleanse(&mut secret);
        return Err(invalid());
    }
    // Transfer ownership so there is no second copy of the secret.
    Ok(SharedSecret::from(secret))
}

/// Client key share: ML-KEM-768 encapsulation key, then X25519 public key.
const HYBRID_CLIENT_SHARE_LEN: usize = mlkem::ENCAP_KEY_LEN + X25519_LEN;
/// Server key share: ML-KEM-768 ciphertext, then X25519 public key.
const HYBRID_SERVER_SHARE_LEN: usize = mlkem::CIPHERTEXT_LEN + X25519_LEN;
/// Shared secret: ML-KEM-768 shared secret, then X25519 shared secret.
const HYBRID_SECRET_LEN: usize = mlkem::SHARED_SECRET_LEN + X25519_LEN;

/// The X25519MLKEM768 post-quantum hybrid from draft-ietf-tls-ecdhe-mlkem:
/// ML-KEM-768 and X25519 run side by side and both secrets feed the key
/// schedule, so confidentiality holds as long as *either* survives. Note
/// the wire format puts the ML-KEM half first in the shares and the secret,
/// despite the group's name.
#[derive(Debug)]
pub(crate) struct X25519MLKEM768;

impl SupportedKxGroup for X25519MLKEM768 {
    fn name(&self) -> NamedGroup {
        NamedGroup::X25519MLKEM768
    }

    fn usable_for_version(&self, version: ProtocolVersion) -> bool {
        version == ProtocolVersion::TLSv1_3
    }

    /// Client role: offer an encapsulation key and an X25519 share.
    fn start(&self) -> Result<Box<dyn ActiveKeyExchange>, Error> {
        let (mlkem, encap_key) = mlkem::DecapKey::generate();
        let x25519 = PKey::generate_x25519().map_err(|e| general_error("x25519 keygen", e))?;
        let x25519_pub = x25519
            .raw_public_key()
            .map_err(|e| general_error("x25519 public key", e))?;
        let mut pub_bytes = Vec::with_capacity(HYBRID_CLIENT_SHARE_LEN);
        pub_bytes.extend_from_slice(&encap_key);
        pub_bytes.extend_from_slice(&x25519_pub);
        Ok(Box::new(HybridActive {
            mlkem,
            x25519,
            pub_bytes,
        }))
    }

    /// Server role: encapsulate to the client's ML-KEM key and answer the
    /// X25519 share with a fresh one. A KEM has a data dependency between
    /// the two shares, so the `start()`/`complete()` split cannot express
    /// this side of the exchange.
    fn start_and_complete(&self, client_share: &[u8]) -> Result<CompletedKeyExchange, Error> {
        let invalid = || Error::from(rustls::PeerMisbehaved::InvalidKeyShare);
        if client_share.len() != HYBRID_CLIENT_SHARE_LEN {
            return Err(invalid());
        }
        let (mlkem_share, peer_x25519) = client_share.split_at(mlkem::ENCAP_KEY_LEN);
        let encap_key = mlkem::EncapKey::parse(mlkem_share).ok_or_else(invalid)?;

        let x25519 = PKey::generate_x25519().map_err(|e| general_error("x25519 keygen", e))?;
        let x25519_pub = x25519
            .raw_public_key()
            .map_err(|e| general_error("x25519 public key", e))?;

        let mut pub_key = vec![0u8; HYBRID_SERVER_SHARE_LEN];
        let mut secret = vec![0u8; HYBRID_SECRET_LEN];
        let (ciphertext, x25519_share) = pub_key.split_at_mut(mlkem::CIPHERTEXT_LEN);
        let (mlkem_secret, x25519_secret) = secret.split_at_mut(mlkem::SHARED_SECRET_LEN);
        encap_key.encap(
            ciphertext.try_into().expect("split at CIPHERTEXT_LEN"),
            mlkem_secret.try_into().expect("split at SHARED_SECRET_LEN"),
        );
        x25519_share.copy_from_slice(&x25519_pub);
        if let Err(e) = x25519_derive_into(&x25519, peer_x25519, x25519_secret) {
            crate::cleanse(&mut secret);
            return Err(e);
        }
        Ok(CompletedKeyExchange {
            group: NamedGroup::X25519MLKEM768,
            pub_key,
            secret: SharedSecret::from(secret),
        })
    }
}

struct HybridActive {
    mlkem: mlkem::DecapKey,
    x25519: PKey<Private>,
    /// Encapsulation key, then X25519 public key.
    pub_bytes: Vec<u8>,
}

impl ActiveKeyExchange for HybridActive {
    fn complete(self: Box<Self>, peer_pub_key: &[u8]) -> Result<SharedSecret, Error> {
        let invalid = || Error::from(rustls::PeerMisbehaved::InvalidKeyShare);
        if peer_pub_key.len() != HYBRID_SERVER_SHARE_LEN {
            return Err(invalid());
        }
        let (ciphertext, peer_x25519) = peer_pub_key.split_at(mlkem::CIPHERTEXT_LEN);
        let mut secret = vec![0u8; HYBRID_SECRET_LEN];
        let (mlkem_secret, x25519_secret) = secret.split_at_mut(mlkem::SHARED_SECRET_LEN);
        // Decapsulation cannot fail on a length-checked ciphertext: a
        // corrupt one yields the implicit-rejection secret and the
        // handshake dies later, in the Finished exchange.
        let derived = self
            .mlkem
            .decap(
                ciphertext,
                mlkem_secret.try_into().expect("split at SHARED_SECRET_LEN"),
            )
            .map_err(|()| invalid())
            .and_then(|()| x25519_derive_into(&self.x25519, peer_x25519, x25519_secret));
        if let Err(e) = derived {
            crate::cleanse(&mut secret);
            return Err(e);
        }
        Ok(SharedSecret::from(secret))
    }

    /// Expose the X25519 half. rustls appends it to the ClientHello as a
    /// second key share, and completes with it directly if the server
    /// picks classical X25519 — no HelloRetryRequest, no second keygen.
    fn hybrid_component(&self) -> Option<(NamedGroup, &[u8])> {
        Some((NamedGroup::X25519, &self.pub_bytes[mlkem::ENCAP_KEY_LEN..]))
    }

    fn complete_hybrid_component(
        self: Box<Self>,
        peer_pub_key: &[u8],
    ) -> Result<SharedSecret, Error> {
        let mut secret = vec![0u8; X25519_LEN];
        if let Err(e) = x25519_derive_into(&self.x25519, peer_pub_key, &mut secret) {
            crate::cleanse(&mut secret);
            return Err(e);
        }
        Ok(SharedSecret::from(secret))
    }

    fn pub_key(&self) -> &[u8] {
        &self.pub_bytes
    }

    fn group(&self) -> NamedGroup {
        NamedGroup::X25519MLKEM768
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::hex;

    #[test]
    fn x25519_rfc7748_vector() {
        // RFC 7748 section 6.1
        let alice_priv = [
            0x77, 0x07, 0x6d, 0x0a, 0x73, 0x18, 0xa5, 0x7d, 0x3c, 0x16, 0xc1, 0x72, 0x51, 0xb2,
            0x66, 0x45, 0xdf, 0x4c, 0x2f, 0x87, 0xeb, 0xc0, 0x99, 0x2a, 0xb1, 0x77, 0xfb, 0xa5,
            0x1d, 0xb9, 0x2c, 0x2a,
        ];
        let alice_pub = [
            0x85, 0x20, 0xf0, 0x09, 0x89, 0x30, 0xa7, 0x54, 0x74, 0x8b, 0x7d, 0xdc, 0xb4, 0x3e,
            0xf7, 0x5a, 0x0d, 0xbf, 0x3a, 0x0d, 0x26, 0x38, 0x1a, 0xf4, 0xeb, 0xa4, 0xa9, 0x8e,
            0xaa, 0x9b, 0x4e, 0x6a,
        ];
        let bob_pub = [
            0xde, 0x9e, 0xdb, 0x7d, 0x7b, 0x7d, 0xc1, 0xb4, 0xd3, 0x5b, 0x61, 0xc2, 0xec, 0xe4,
            0x35, 0x37, 0x3f, 0x83, 0x43, 0xc8, 0x5b, 0x78, 0x67, 0x4d, 0xad, 0xfc, 0x7e, 0x14,
            0x6f, 0x88, 0x2b, 0x4f,
        ];
        let shared = [
            0x4a, 0x5d, 0x9d, 0x5b, 0xa4, 0xce, 0x2d, 0xe1, 0x72, 0x8e, 0x3b, 0xf4, 0x80, 0x35,
            0x0f, 0x25, 0xe0, 0x7e, 0x21, 0xc9, 0x47, 0xd1, 0x9e, 0x33, 0x76, 0xf0, 0x9b, 0x3c,
            0x1e, 0x16, 0x17, 0x42,
        ];

        let key = PKey::private_key_from_raw_bytes(&alice_priv, Id::X25519).unwrap();
        let kx = Box::new(X25519Active::from_pkey(key).unwrap());
        assert_eq!(kx.pub_key(), alice_pub);
        let secret = kx.complete(&bob_pub).unwrap();
        assert_eq!(secret.secret_bytes(), shared);
    }

    #[test]
    fn x25519_rejects_low_order_point() {
        for low_order in [[0u8; X25519_LEN], {
            let mut one = [0u8; X25519_LEN];
            one[0] = 1;
            one
        }] {
            let kx = X25519.start().unwrap();
            assert!(kx.complete(&low_order).is_err());
        }
    }

    #[test]
    fn x25519_rejects_wrong_public_key_lengths() {
        for len in [0, X25519_LEN - 1, X25519_LEN + 1] {
            assert!(X25519.start().unwrap().complete(&vec![0u8; len]).is_err());
        }
    }

    #[test]
    fn nist_groups_roundtrip() {
        for (group, public_len, secret_len) in [
            (&SECP256R1 as &dyn SupportedKxGroup, 65, 32),
            (&SECP384R1 as &dyn SupportedKxGroup, 97, 48),
        ] {
            let a = group.start().unwrap();
            let b = group.start().unwrap();
            let a_pub = a.pub_key().to_vec();
            let b_pub = b.pub_key().to_vec();
            assert_eq!(a_pub.len(), public_len);
            assert_eq!(b_pub.len(), public_len);
            let s1 = a.complete(&b_pub).unwrap();
            let s2 = b.complete(&a_pub).unwrap();
            assert_eq!(s1.secret_bytes().len(), secret_len);
            assert_eq!(s1.secret_bytes(), s2.secret_bytes());
        }
    }

    fn nist_kat(
        nid: Nid,
        private: &str,
        peer_public: &str,
        expected: &str,
        encoded_len: usize,
        secret_len: usize,
    ) {
        let group = EcGroup::from_curve_name(nid).unwrap();
        let private = openssl::bn::BigNum::from_slice(&hex(private)).unwrap();
        let mut ctx = BigNumContext::new().unwrap();
        let mut public = EcPoint::new(&group).unwrap();
        public.mul_generator2(&group, &private, &mut ctx).unwrap();
        let key = EcKey::from_private_components(&group, &private, &public).unwrap();
        let key = PKey::from_ec_key(key).unwrap();

        let secret =
            ecdh_complete(&group, &key, &hex(peer_public), encoded_len, secret_len).unwrap();
        assert_eq!(secret.secret_bytes(), hex(expected));
    }

    #[test]
    fn nist_ecdh_known_answer_vectors() {
        // NIST CAVP vectors, also published in RFC 5903 section 8.
        nist_kat(
            Nid::X9_62_PRIME256V1,
            "C88F01F510D9AC3F70A292DAA2316DE544E9AAB8AFE84049C62A9C57862D1433",
            "04D12DFB5289C8D4F81208B70270398C342296970A0BCCB74C736FC7554494BF6\
             356FBF3CA366CC23E8157854C13C58D6AAC23F046ADA30F8353E74F33039872AB",
            "D6840F6B42F6EDAFD13116E0E12565202FEF8E9ECE7DCE03812464D04B9442DE",
            65,
            32,
        );
        nist_kat(
            Nid::SECP384R1,
            "099F3C7034D4A2C699884D73A375A67F7624EF7C6B3C0F160647B67414DCE655\
             E35B538041E649EE3FAEF896783AB194",
            "04E558DBEF53EECDE3D3FCCFC1AEA08A89A987475D12FD950D83CFA41732BC509D\
             0D1AC43A0336DEF96FDA41D0774A3571DCFBEC7AACF3196472169E838430367F66\
             EEBE3C6E70C416DD5F0C68759DD1FFF83FA40142209DFF5EAAD96DB9E6386C",
            "11187331C279962D93D604243FD592CB9D0A926F422E47187521287E7156C5C4\
             D603135569B9E9D09CF5D4A270F59746",
            97,
            48,
        );
    }

    #[test]
    fn p256_rejects_invalid_point() {
        let kx = SECP256R1.start().unwrap();
        let mut junk = vec![0x04u8; 65];
        junk[64] = 0xff;
        assert!(kx.complete(&junk).is_err());
    }

    #[test]
    fn nist_groups_reject_wrong_lengths_and_off_curve_points() {
        for (group, encoded_len) in [
            (&SECP256R1 as &dyn SupportedKxGroup, 65),
            (&SECP384R1 as &dyn SupportedKxGroup, 97),
        ] {
            for len in [0, encoded_len - 1, encoded_len + 1] {
                assert!(group.start().unwrap().complete(&vec![0x04; len]).is_err());
            }
            let mut off_curve = vec![0xff; encoded_len];
            off_curve[0] = 0x04;
            assert!(group.start().unwrap().complete(&off_curve).is_err());
        }
    }

    #[test]
    fn nist_groups_reject_non_uncompressed_encodings() {
        let cases: &[(&dyn SupportedKxGroup, Nid)] = &[
            (&SECP256R1, Nid::X9_62_PRIME256V1),
            (&SECP384R1, Nid::SECP384R1),
        ];

        for &(kx_group, nid) in cases {
            let ec_group = EcGroup::from_curve_name(nid).unwrap();
            let peer = EcKey::generate(&ec_group).unwrap();
            let mut ctx = BigNumContext::new().unwrap();
            let compressed = peer
                .public_key()
                .to_bytes(&ec_group, PointConversionForm::COMPRESSED, &mut ctx)
                .unwrap();
            let mut hybrid = peer
                .public_key()
                .to_bytes(&ec_group, PointConversionForm::UNCOMPRESSED, &mut ctx)
                .unwrap();
            let y_lsb = hybrid[hybrid.len() - 1] & 1;
            hybrid[0] = 0x06 | y_lsb;

            for invalid_encoding in [&compressed[..], &hybrid[..]] {
                let result = kx_group.start().unwrap().complete(invalid_encoding);
                assert!(matches!(
                    result,
                    Err(Error::PeerMisbehaved(
                        rustls::PeerMisbehaved::InvalidKeyShare
                    ))
                ));
            }
        }
    }

    #[test]
    fn x25519mlkem768_roundtrip() {
        assert!(X25519MLKEM768.usable_for_version(ProtocolVersion::TLSv1_3));
        assert!(!X25519MLKEM768.usable_for_version(ProtocolVersion::TLSv1_2));
        let client = X25519MLKEM768.start().unwrap();
        assert_eq!(client.group(), NamedGroup::X25519MLKEM768);
        assert_eq!(client.pub_key().len(), HYBRID_CLIENT_SHARE_LEN);

        let server = X25519MLKEM768.start_and_complete(client.pub_key()).unwrap();
        assert_eq!(server.group, NamedGroup::X25519MLKEM768);
        assert_eq!(server.pub_key.len(), HYBRID_SERVER_SHARE_LEN);

        let client_secret = client.complete(&server.pub_key).unwrap();
        assert_eq!(client_secret.secret_bytes().len(), HYBRID_SECRET_LEN);
        assert_eq!(client_secret.secret_bytes(), server.secret.secret_bytes());
    }

    /// Play the server by hand with the raw primitives, so a concatenation
    /// order swapped consistently on both of our sides cannot cancel out:
    /// the shares and the secret are ML-KEM first, X25519 second.
    #[test]
    fn x25519mlkem768_layout_is_mlkem_then_x25519() {
        let client = X25519MLKEM768.start().unwrap();
        let (mlkem_share, x25519_share) = client.pub_key().split_at(mlkem::ENCAP_KEY_LEN);

        let encap_key = mlkem::EncapKey::parse(mlkem_share).unwrap();
        let mut ciphertext = [0u8; mlkem::CIPHERTEXT_LEN];
        let mut mlkem_secret = [0u8; mlkem::SHARED_SECRET_LEN];
        encap_key.encap(&mut ciphertext, &mut mlkem_secret);

        let x25519 = PKey::generate_x25519().unwrap();
        let mut x25519_secret = [0u8; X25519_LEN];
        x25519_derive_into(&x25519, x25519_share, &mut x25519_secret).unwrap();

        let mut server_share = ciphertext.to_vec();
        server_share.extend_from_slice(&x25519.raw_public_key().unwrap());

        let secret = client.complete(&server_share).unwrap();
        assert_eq!(
            &secret.secret_bytes()[..mlkem::SHARED_SECRET_LEN],
            mlkem_secret
        );
        assert_eq!(
            &secret.secret_bytes()[mlkem::SHARED_SECRET_LEN..],
            x25519_secret
        );
    }

    #[test]
    fn x25519mlkem768_rejects_wrong_share_lengths() {
        for len in [0, HYBRID_CLIENT_SHARE_LEN - 1, HYBRID_CLIENT_SHARE_LEN + 1] {
            assert!(X25519MLKEM768.start_and_complete(&vec![0u8; len]).is_err());
        }
        for len in [0, HYBRID_SERVER_SHARE_LEN - 1, HYBRID_SERVER_SHARE_LEN + 1] {
            let client = X25519MLKEM768.start().unwrap();
            assert!(client.complete(&vec![0u8; len]).is_err());
        }
    }

    #[test]
    fn x25519mlkem768_server_rejects_unreduced_encap_key() {
        // A valid X25519 half, so only the ML-KEM half (0xff-saturated
        // coefficients, >= q) is at fault.
        let mut share = vec![0xffu8; HYBRID_CLIENT_SHARE_LEN];
        let x25519 = PKey::generate_x25519().unwrap();
        share[mlkem::ENCAP_KEY_LEN..].copy_from_slice(&x25519.raw_public_key().unwrap());
        assert!(matches!(
            X25519MLKEM768.start_and_complete(&share),
            Err(Error::PeerMisbehaved(
                rustls::PeerMisbehaved::InvalidKeyShare
            ))
        ));
    }

    #[test]
    fn x25519mlkem768_rejects_low_order_x25519_component() {
        // Server side: low-order point in the client share.
        let client = X25519MLKEM768.start().unwrap();
        let mut share = client.pub_key().to_vec();
        share[mlkem::ENCAP_KEY_LEN..].fill(0);
        assert!(X25519MLKEM768.start_and_complete(&share).is_err());

        // Client side: low-order point in the server share.
        let server = X25519MLKEM768.start_and_complete(client.pub_key()).unwrap();
        let mut share = server.pub_key.clone();
        share[mlkem::CIPHERTEXT_LEN..].fill(0);
        assert!(client.complete(&share).is_err());
    }

    #[test]
    fn x25519mlkem768_corrupt_ciphertext_mismatches_secrets() {
        let client = X25519MLKEM768.start().unwrap();
        let server = X25519MLKEM768.start_and_complete(client.pub_key()).unwrap();
        let mut share = server.pub_key.clone();
        share[0] ^= 1;
        // Implicit rejection: completion succeeds, agreement fails, and a
        // real handshake dies in the Finished exchange.
        let secret = client.complete(&share).unwrap();
        assert_ne!(secret.secret_bytes(), server.secret.secret_bytes());
    }

    #[test]
    fn x25519mlkem768_hybrid_component_is_the_x25519_half() {
        let client = X25519MLKEM768.start().unwrap();
        let (group, component) = client.hybrid_component().unwrap();
        assert_eq!(group, NamedGroup::X25519);
        assert_eq!(component, &client.pub_key()[mlkem::ENCAP_KEY_LEN..]);

        // The component completes as a plain X25519 exchange.
        let peer = X25519.start().unwrap();
        let peer_pub = peer.pub_key().to_vec();
        let component = component.to_vec();
        let ours = client.complete_hybrid_component(&peer_pub).unwrap();
        let theirs = peer.complete(&component).unwrap();
        assert_eq!(ours.secret_bytes(), theirs.secret_bytes());
    }
}
