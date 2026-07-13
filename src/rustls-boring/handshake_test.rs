// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! Full in-memory TLS 1.3 handshakes over this provider, shaped exactly like
//! iroh's usage: RFC 7250 raw public keys, mutual authentication, and a
//! custom verifier — no WebPKI certificates anywhere. The verifier accepts
//! the presented key as trusted, while TLS CertificateVerify still proves
//! possession; this is protocol integration coverage, not a trust-policy
//! test. The main path uses Ed25519, with focused end-to-end coverage for
//! ECDSA and RSA as well.

use std::io::{Read, Write};
use std::sync::Arc;

use openssl::ec::{EcGroup, EcKey};
use openssl::nid::Nid;
use openssl::pkey::{PKey, Private};
use openssl::rsa::Rsa;
use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::crypto::verify_tls13_signature_with_raw_key;
use rustls::pki_types::{
    CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer, ServerName, SubjectPublicKeyInfoDer,
    UnixTime,
};
use rustls::server::danger::{ClientCertVerified, ClientCertVerifier};
use rustls::sign::CertifiedKey;
use rustls::{
    ClientConfig, ClientConnection, DigitallySignedStruct, DistinguishedName, Error, ServerConfig,
    ServerConnection, SignatureScheme,
};

use crate::verify;

/// An Ed25519 identity presented as a raw-public-key "certificate".
struct Identity {
    cert: CertificateDer<'static>,
    certified: Arc<CertifiedKey>,
}

#[derive(Clone, Copy, Debug)]
enum IdentityKind {
    Ed25519,
    EcdsaP256,
    EcdsaP384,
    Rsa,
}

impl IdentityKind {
    fn generate(self) -> PKey<Private> {
        match self {
            Self::Ed25519 => PKey::generate_ed25519().unwrap(),
            Self::EcdsaP256 | Self::EcdsaP384 => {
                let nid = match self {
                    Self::EcdsaP256 => Nid::X9_62_PRIME256V1,
                    Self::EcdsaP384 => Nid::SECP384R1,
                    _ => unreachable!(),
                };
                let group = EcGroup::from_curve_name(nid).unwrap();
                PKey::from_ec_key(EcKey::generate(&group).unwrap()).unwrap()
            }
            Self::Rsa => PKey::from_rsa(Rsa::generate(2048).unwrap()).unwrap(),
        }
    }
}

fn identity(provider: &rustls::crypto::CryptoProvider, kind: IdentityKind) -> Identity {
    let key = kind.generate();
    let cert = CertificateDer::from(key.public_key_to_der().unwrap());
    let signing_key = provider
        .key_provider
        .load_private_key(PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(
            key.private_key_to_pkcs8().unwrap(),
        )))
        .unwrap();
    let certified = Arc::new(CertifiedKey::new(vec![cert.clone()], signing_key));
    Identity { cert, certified }
}

#[derive(Debug)]
struct RawKeyServerVerifier;

impl ServerCertVerifier for RawKeyServerVerifier {
    fn verify_server_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        intermediates: &[CertificateDer<'_>],
        _server_name: &ServerName<'_>,
        _ocsp_response: &[u8],
        _now: UnixTime,
    ) -> Result<ServerCertVerified, Error> {
        assert!(intermediates.is_empty());
        assert!(!end_entity.is_empty());
        Ok(ServerCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        _: &[u8],
        _: &CertificateDer<'_>,
        _: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, Error> {
        Err(Error::PeerIncompatible(
            rustls::PeerIncompatible::Tls12NotOffered,
        ))
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, Error> {
        verify_tls13_signature_with_raw_key(
            message,
            &SubjectPublicKeyInfoDer::from(cert.as_ref()),
            dss,
            &verify::SUPPORTED_SIG_ALGS,
        )
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        verify::SUPPORTED_SIG_ALGS.supported_schemes()
    }

    fn requires_raw_public_keys(&self) -> bool {
        true
    }
}

#[derive(Debug)]
struct RawKeyClientVerifier;

impl ClientCertVerifier for RawKeyClientVerifier {
    fn offer_client_auth(&self) -> bool {
        true
    }

    fn verify_client_cert(
        &self,
        _end_entity: &CertificateDer<'_>,
        intermediates: &[CertificateDer<'_>],
        _now: UnixTime,
    ) -> Result<ClientCertVerified, Error> {
        assert!(intermediates.is_empty());
        Ok(ClientCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        _: &[u8],
        _: &CertificateDer<'_>,
        _: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, Error> {
        Err(Error::PeerIncompatible(
            rustls::PeerIncompatible::Tls12NotOffered,
        ))
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, Error> {
        verify_tls13_signature_with_raw_key(
            message,
            &SubjectPublicKeyInfoDer::from(cert.as_ref()),
            dss,
            &verify::SUPPORTED_SIG_ALGS,
        )
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        verify::SUPPORTED_SIG_ALGS.supported_schemes()
    }

    fn root_hint_subjects(&self) -> &[DistinguishedName] {
        &[]
    }

    fn requires_raw_public_keys(&self) -> bool {
        true
    }
}

#[derive(Debug)]
struct AlwaysResolves(Arc<CertifiedKey>);

impl rustls::server::ResolvesServerCert for AlwaysResolves {
    fn resolve(&self, _: rustls::server::ClientHello<'_>) -> Option<Arc<CertifiedKey>> {
        Some(self.0.clone())
    }

    fn only_raw_public_keys(&self) -> bool {
        true
    }
}

impl rustls::client::ResolvesClientCert for AlwaysResolves {
    fn resolve(
        &self,
        _root_hint_subjects: &[&[u8]],
        _sigschemes: &[SignatureScheme],
    ) -> Option<Arc<CertifiedKey>> {
        Some(self.0.clone())
    }

    fn only_raw_public_keys(&self) -> bool {
        true
    }

    fn has_certs(&self) -> bool {
        true
    }
}

fn pump(client: &mut ClientConnection, server: &mut ServerConnection) {
    for _ in 0..16 {
        while client.wants_write() {
            let mut buf = Vec::new();
            client.write_tls(&mut buf).unwrap();
            let mut rd = &buf[..];
            while !rd.is_empty() {
                server.read_tls(&mut rd).unwrap();
            }
            server.process_new_packets().unwrap();
        }
        while server.wants_write() {
            let mut buf = Vec::new();
            server.write_tls(&mut buf).unwrap();
            let mut rd = &buf[..];
            while !rd.is_empty() {
                client.read_tls(&mut rd).unwrap();
            }
            client.process_new_packets().unwrap();
        }
        if !client.is_handshaking() && !server.is_handshaking() {
            break;
        }
    }
    assert!(!client.is_handshaking(), "client still handshaking");
    assert!(!server.is_handshaking(), "server still handshaking");
}

/// Handshake between (possibly different) client and server providers,
/// verify mutual raw-key auth, and exchange application data both ways.
fn handshake_between(
    client_provider: Arc<rustls::crypto::CryptoProvider>,
    server_provider: Arc<rustls::crypto::CryptoProvider>,
) -> (ClientConnection, ServerConnection) {
    handshake_between_with_identity(client_provider, server_provider, IdentityKind::Ed25519)
}

fn handshake_between_with_identity(
    client_provider: Arc<rustls::crypto::CryptoProvider>,
    server_provider: Arc<rustls::crypto::CryptoProvider>,
    identity_kind: IdentityKind,
) -> (ClientConnection, ServerConnection) {
    let server_id = identity(&server_provider, identity_kind);
    let client_id = identity(&client_provider, identity_kind);

    let server_config = ServerConfig::builder_with_provider(server_provider)
        .with_protocol_versions(&[&rustls::version::TLS13])
        .unwrap()
        .with_client_cert_verifier(Arc::new(RawKeyClientVerifier))
        .with_cert_resolver(Arc::new(AlwaysResolves(server_id.certified.clone())));

    let client_config = ClientConfig::builder_with_provider(client_provider)
        .with_protocol_versions(&[&rustls::version::TLS13])
        .unwrap()
        .dangerous()
        .with_custom_certificate_verifier(Arc::new(RawKeyServerVerifier))
        .with_client_cert_resolver(Arc::new(AlwaysResolves(client_id.certified.clone())));

    let mut client = ClientConnection::new(
        Arc::new(client_config),
        ServerName::try_from("testhost").unwrap(),
    )
    .unwrap();
    let mut server = ServerConnection::new(Arc::new(server_config)).unwrap();

    pump(&mut client, &mut server);

    // Both sides proved possession of the presented raw SPKI keys. The
    // custom verifier above deliberately treats those keys as trusted.
    let server_seen = client.peer_certificates().unwrap();
    assert_eq!(server_seen[0].as_ref(), server_id.cert.as_ref());
    let client_seen = server.peer_certificates().unwrap();
    assert_eq!(client_seen[0].as_ref(), client_id.cert.as_ref());

    // Application data, both directions.
    client.writer().write_all(b"ping from client").unwrap();
    let mut buf = Vec::new();
    client.write_tls(&mut buf).unwrap();
    let mut rd = &buf[..];
    server.read_tls(&mut rd).unwrap();
    server.process_new_packets().unwrap();
    let mut got = [0u8; 16];
    server.reader().read_exact(&mut got).unwrap();
    assert_eq!(&got, b"ping from client");

    server.writer().write_all(b"pong from server").unwrap();
    let mut buf = Vec::new();
    server.write_tls(&mut buf).unwrap();
    let mut rd = &buf[..];
    client.read_tls(&mut rd).unwrap();
    client.process_new_packets().unwrap();
    let mut got = [0u8; 16];
    client.reader().read_exact(&mut got).unwrap();
    assert_eq!(&got, b"pong from server");

    (client, server)
}

/// [`handshake_between`] with the same provider on both sides.
fn handshake(provider: Arc<rustls::crypto::CryptoProvider>) -> ClientConnection {
    handshake_between(provider.clone(), provider).0
}

fn provider_with_kx(
    kx_groups: Vec<&'static dyn rustls::crypto::SupportedKxGroup>,
) -> Arc<rustls::crypto::CryptoProvider> {
    Arc::new(rustls::crypto::CryptoProvider {
        kx_groups,
        ..crate::provider()
    })
}

#[test]
fn tls13_raw_public_key_mutual_auth_handshake() {
    let client = handshake(crate::arc_provider());
    let negotiated = client.negotiated_cipher_suite().unwrap();
    assert!(
        crate::suites::ALL_CIPHER_SUITES.contains(&negotiated),
        "negotiated foreign suite {negotiated:?}"
    );
}

#[test]
fn tls13_mutual_auth_over_every_signing_key_type() {
    for kind in [
        IdentityKind::Ed25519,
        IdentityKind::EcdsaP256,
        IdentityKind::EcdsaP384,
        IdentityKind::Rsa,
    ] {
        let provider = crate::arc_provider();
        let (client, server) = handshake_between_with_identity(provider.clone(), provider, kind);
        assert!(!client.is_handshaking(), "client failed with {kind:?}");
        assert!(!server.is_handshaking(), "server failed with {kind:?}");
    }
}

/// The same handshake, forced onto each individual suite. This is the
/// end-to-end record protection coverage for AES-128-GCM in particular,
/// whose 16-byte traffic keys can only come from the real key schedule
/// (the public [`rustls::crypto::cipher::AeadKey`] constructor is 32-byte
/// only, and the AEAD engine rejects wrong-length keys).
#[test]
fn tls13_handshake_over_each_suite() {
    for suite in crate::suites::ALL_CIPHER_SUITES {
        let provider = rustls::crypto::CryptoProvider {
            cipher_suites: vec![*suite],
            ..crate::provider()
        };
        let client = handshake(Arc::new(provider));
        assert_eq!(
            client.negotiated_cipher_suite().unwrap().suite(),
            suite.suite(),
            "handshake landed on a different suite than the one offered"
        );
    }
}

/// Exercise the rustls key-schedule integration for every group — including
/// a hybrid-only handshake where X25519MLKEM768 has no fallback — rather
/// than only the provider-preferred path used by the other handshakes.
#[test]
fn tls13_handshake_over_each_key_exchange_group() {
    for group in crate::kx::ALL_KX_GROUPS {
        let provider = provider_with_kx(vec![*group]);
        let (client, _) = handshake_between(provider.clone(), provider);
        assert_eq!(
            client.negotiated_key_exchange_group().map(|g| g.name()),
            Some(group.name()),
        );
    }
}

/// The provider's default preference is the post-quantum hybrid.
#[test]
fn tls13_default_handshake_negotiates_x25519mlkem768() {
    let client = handshake(crate::arc_provider());
    assert_eq!(
        client.negotiated_key_exchange_group().map(|g| g.name()),
        Some(rustls::NamedGroup::X25519MLKEM768),
    );
}

/// A hybrid-capable client interoperates with a classical-only X25519 server.
/// The unit test in `kx` separately checks that the exposed hybrid component
/// is exactly the embedded X25519 share used by this fallback path.
#[test]
fn tls13_hybrid_client_downgrades_to_classical_only_server() {
    let (client, server) = handshake_between(
        crate::arc_provider(),
        provider_with_kx(vec![crate::kx_group::X25519]),
    );
    for negotiated in [
        client.negotiated_key_exchange_group(),
        server.negotiated_key_exchange_group(),
    ] {
        assert_eq!(
            negotiated.map(|g| g.name()),
            Some(rustls::NamedGroup::X25519),
        );
    }
}

/// A server sharing no group with the client's two key shares (hybrid and
/// its X25519 component) forces a HelloRetryRequest, restarting the
/// handshake onto a fresh P-256 exchange.
#[test]
fn tls13_hello_retry_request_onto_p256() {
    let (client, _server) = handshake_between(
        crate::arc_provider(),
        provider_with_kx(vec![crate::kx_group::SECP256R1]),
    );
    assert_eq!(
        client.negotiated_key_exchange_group().map(|g| g.name()),
        Some(rustls::NamedGroup::secp256r1),
    );
}
