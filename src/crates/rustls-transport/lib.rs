// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: MIT OR Apache-2.0

//! Ties rustls to the transport-neutral [`Accept`] abstraction.
//!
//! [`TlsAccept`] wraps any inner acceptor and yields streams that have
//! completed a rustls handshake, using whatever crypto provider the given
//! [`rustls::ServerConfig`] was built with — in this repository that is
//! BoringSSL via `rustls-boring` (see [`server_config_from_pem`]). It has
//! no opinion about the protocol served on top; pair it with any driver
//! of [`Accept`] sources.
//!
//! Handshakes run concurrently: a peer that stalls mid-handshake cannot
//! hold up the accept loop, and one that fails loses only its own
//! connection. [`HANDSHAKE_TIMEOUT`] bounds how long a handshake may stay
//! in flight.

use std::io;
use std::sync::Arc;
use std::time::Duration;

use accept::Accept;
use futures::stream::{FuturesUnordered, StreamExt as _};
use rustls::pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer};
use tokio::time::Timeout;
use tokio_rustls::server::TlsStream;

/// How long a TLS handshake may stay in flight before its connection is
/// dropped, bounding what a slow-loris peer can pin.
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(10);

// -------------------------------------------------------------------------------------------------

/// Build a TLS 1.3 [`rustls::ServerConfig`] from a PEM certificate chain
/// and private key, advertising `h2` and `http/1.1`.
///
/// TLS 1.3 only, matching the cipher suites our BoringSSL provider
/// offers. PEM parsing also goes through BoringSSL (the `openssl` crate),
/// so any chain/key format it reads is accepted; the handshake crypto
/// comes from `provider`.
pub fn server_config_from_pem(
    provider: Arc<rustls::crypto::CryptoProvider>,
    cert_pem: &[u8],
    key_pem: &[u8],
) -> Result<rustls::ServerConfig, Box<dyn std::error::Error + Send + Sync>> {
    let certs = openssl::x509::X509::stack_from_pem(cert_pem)?
        .into_iter()
        .map(|cert| Ok(CertificateDer::from(cert.to_der()?)))
        .collect::<Result<Vec<_>, openssl::error::ErrorStack>>()?;
    if certs.is_empty() {
        return Err("no certificates found in PEM input".into());
    }
    let key = openssl::pkey::PKey::private_key_from_pem(key_pem)?;
    let key = PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(key.private_key_to_pkcs8()?));

    let mut config = rustls::ServerConfig::builder_with_provider(provider)
        .with_protocol_versions(&[&rustls::version::TLS13])?
        .with_no_client_auth()
        .with_single_cert(certs, key)?;
    config.alpn_protocols = vec![b"h2".to_vec(), b"http/1.1".to_vec()];
    Ok(config)
}

// -------------------------------------------------------------------------------------------------

/// TLS termination over any [`Accept`] source.
pub struct TlsAccept<A: Accept> {
    inner: A,
    acceptor: tokio_rustls::TlsAcceptor,
    /// Handshakes in flight, each bounded by [`HANDSHAKE_TIMEOUT`]. Kept
    /// in the struct (not the `accept` future) so a cancelled `accept`
    /// call — accept loops race it against shutdown — loses no handshake
    /// progress.
    pending: FuturesUnordered<Timeout<tokio_rustls::Accept<A::Io>>>,
    /// The inner source is exhausted; once `pending` drains, so are we.
    exhausted: bool,
}

impl<A: Accept> TlsAccept<A> {
    pub fn new(inner: A, config: Arc<rustls::ServerConfig>) -> Self {
        Self {
            inner,
            acceptor: tokio_rustls::TlsAcceptor::from(config),
            pending: FuturesUnordered::new(),
            exhausted: false,
        }
    }
}

impl<A: Accept + Send> Accept for TlsAccept<A> {
    type Io = TlsStream<A::Io>;

    async fn accept(&mut self) -> io::Result<Option<Self::Io>> {
        loop {
            tokio::select! {
                conn = self.inner.accept(), if !self.exhausted => match conn? {
                    Some(stream) => self.pending.push(tokio::time::timeout(
                        HANDSHAKE_TIMEOUT,
                        self.acceptor.accept(stream),
                    )),
                    None => self.exhausted = true,
                },
                Some(done) = self.pending.next() => match done {
                    Ok(Ok(tls)) => return Ok(Some(tls)),
                    // Per-peer failures: drop that connection, keep serving.
                    Ok(Err(_err)) => tracing::debug!("TLS handshake failed: {_err}"),
                    Err(_) => {
                        tracing::debug!("TLS handshake timed out after {HANDSHAKE_TIMEOUT:?}")
                    }
                },
                else => return Ok(None),
            }
        }
    }
}

// -------------------------------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    use rustls::SignatureScheme;
    use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
    use rustls::pki_types::ServerName;
    use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};
    use tokio::net::{TcpListener, TcpStream};

    fn fixture(name: &str) -> Vec<u8> {
        std::fs::read(
            buck_resources::get(format!("src/crates/rustls-transport/{name}")).expect("fixture"),
        )
        .expect("read fixture")
    }

    fn test_server_config() -> Arc<rustls::ServerConfig> {
        Arc::new(
            server_config_from_pem(
                rustls_boring::arc_provider(),
                &fixture("cert.pem"),
                &fixture("key.pem"),
            )
            .expect("build server config"),
        )
    }

    /// Accepts whatever certificate the server presents — trust policy is
    /// not under test here, the handshake plumbing is.
    #[derive(Debug)]
    struct TrustAnything;

    impl ServerCertVerifier for TrustAnything {
        fn verify_server_cert(
            &self,
            _end_entity: &CertificateDer<'_>,
            _intermediates: &[CertificateDer<'_>],
            _server_name: &ServerName<'_>,
            _ocsp_response: &[u8],
            _now: rustls::pki_types::UnixTime,
        ) -> Result<ServerCertVerified, rustls::Error> {
            Ok(ServerCertVerified::assertion())
        }

        fn verify_tls12_signature(
            &self,
            _message: &[u8],
            _cert: &CertificateDer<'_>,
            _dss: &rustls::DigitallySignedStruct,
        ) -> Result<HandshakeSignatureValid, rustls::Error> {
            Ok(HandshakeSignatureValid::assertion())
        }

        fn verify_tls13_signature(
            &self,
            _message: &[u8],
            _cert: &CertificateDer<'_>,
            _dss: &rustls::DigitallySignedStruct,
        ) -> Result<HandshakeSignatureValid, rustls::Error> {
            Ok(HandshakeSignatureValid::assertion())
        }

        fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
            vec![
                SignatureScheme::ECDSA_NISTP256_SHA256,
                SignatureScheme::ECDSA_NISTP384_SHA384,
                SignatureScheme::ED25519,
            ]
        }
    }

    async fn connect_tls(addr: std::net::SocketAddr) -> tokio_rustls::client::TlsStream<TcpStream> {
        let mut config = rustls::ClientConfig::builder_with_provider(rustls_boring::arc_provider())
            .with_protocol_versions(&[&rustls::version::TLS13])
            .expect("TLS 1.3 client config")
            .dangerous()
            .with_custom_certificate_verifier(Arc::new(TrustAnything))
            .with_no_client_auth();
        config.alpn_protocols = vec![b"h2".to_vec()];
        let connector = tokio_rustls::TlsConnector::from(Arc::new(config));

        let tcp = TcpStream::connect(addr).await.expect("connect to server");
        connector
            .connect(ServerName::try_from("localhost").expect("server name"), tcp)
            .await
            .expect("TLS handshake")
    }

    /// Accept one TLS connection and echo four bytes back over it.
    fn spawn_echo_server(listener: TcpListener) -> tokio::task::JoinHandle<()> {
        let mut acceptor = TlsAccept::new(listener, test_server_config());
        tokio::spawn(async move {
            let mut tls = acceptor
                .accept()
                .await
                .expect("accept")
                .expect("a connection, not exhaustion");
            let mut buf = [0u8; 4];
            tls.read_exact(&mut buf).await.expect("server read");
            tls.write_all(&buf).await.expect("server write");
            tls.flush().await.expect("server flush");
            // Wait for the peer to hang up so the echo is flushed through
            // the TLS layer before the stream drops.
            let _ = tls.read(&mut [0u8; 1]).await;
        })
    }

    #[tokio::test]
    async fn tls_echo_roundtrip() {
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let addr = listener.local_addr().expect("local addr");
        let server = spawn_echo_server(listener);

        let mut tls = connect_tls(addr).await;
        assert_eq!(
            tls.get_ref().1.alpn_protocol(),
            Some(&b"h2"[..]),
            "config must advertise h2"
        );
        tls.write_all(b"ping").await.expect("client write");
        tls.flush().await.expect("client flush");
        let mut buf = [0u8; 4];
        tls.read_exact(&mut buf).await.expect("client read");
        assert_eq!(&buf, b"ping");

        drop(tls);
        server.await.expect("server task");
    }

    /// A peer that speaks garbage instead of TLS loses only its own
    /// connection: the acceptor keeps accepting.
    #[tokio::test]
    async fn garbage_handshake_does_not_stop_accepting() {
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let addr = listener.local_addr().expect("local addr");
        let server = spawn_echo_server(listener);

        let mut garbage = TcpStream::connect(addr).await.expect("connect garbage");
        garbage
            .write_all(b"this is definitely not a ClientHello")
            .await
            .expect("write garbage");
        // Wait for the rejection (EOF or reset), so the failure has
        // happened before the real client dials.
        let _ = garbage.read_to_end(&mut Vec::new()).await;
        drop(garbage);

        let mut tls = connect_tls(addr).await;
        tls.write_all(b"ping").await.expect("client write");
        tls.flush().await.expect("client flush");
        let mut buf = [0u8; 4];
        tls.read_exact(&mut buf).await.expect("client read");
        assert_eq!(&buf, b"ping");

        drop(tls);
        server.await.expect("server task");
    }

    #[test]
    fn server_config_has_grpc_alpn() {
        let config = test_server_config();
        assert_eq!(
            config.alpn_protocols,
            vec![b"h2".to_vec(), b"http/1.1".to_vec()]
        );
    }

    #[test]
    fn key_handed_over_as_certificate_is_an_error() {
        let err = server_config_from_pem(
            rustls_boring::arc_provider(),
            &fixture("key.pem"),
            &fixture("key.pem"),
        )
        .expect_err("a private key is not a certificate chain");
        assert!(err.to_string().contains("no certificates"), "{err}");
    }
}
