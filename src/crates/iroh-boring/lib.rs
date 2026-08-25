// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: MIT OR Apache-2.0

//! iroh endpoints on the in-tree BoringSSL rustls provider.
//!
//! iroh ships presets that pick a crypto provider for you, but they are
//! feature-gated on its bundled ring and aws-lc-rs stacks, which we build
//! with disabled. [`builder`] is what is left once you strip that away: an
//! endpoint builder on `rustls-boring`, with no relays, no address lookup
//! and no ALPN. The caller adds whichever of those it wants. Because the
//! provider offers X25519MLKEM768 first, two endpoints built this way
//! negotiate a post-quantum hybrid key exchange.
//!
//! Installing the provider as the process default is part of binding
//! rather than something a caller should remember. iroh's relay client
//! reaches for the default provider on its own, so a program that skipped
//! the install would hand its relay traffic to whatever rustls picked.
//!
//! For helpers that do not care which provider is in use, see `iroh-utils`.

use std::sync::Arc;

use iroh::Endpoint;
use iroh::endpoint::{Builder, presets};
use rustls::crypto::CryptoProvider;

/// Installs `rustls-boring` as the process default provider, unless
/// something else claimed that slot first. Only the first install in a
/// process can succeed, which is why the result is dropped rather than
/// reported.
pub fn install_provider() {
    let _ = rustls_boring::provider().install_default();
}

/// An endpoint builder on the BoringSSL provider, with nothing else
/// configured.
pub fn builder() -> Builder {
    builder_with(rustls_boring::arc_provider())
}

/// [`builder`], but with a provider the caller supplies. Useful when the
/// provider is wrapped to observe what a handshake negotiated: the process
/// default stays the plain provider, so unrelated handshakes, DoH and
/// relay HTTP among them, cannot disturb what the wrapper records.
pub fn builder_with(provider: Arc<CryptoProvider>) -> Builder {
    install_provider();
    Endpoint::builder(presets::Empty).crypto_provider(provider)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Two endpoints built here talk to each other over loopback with no
    /// relay and no address lookup, which is the whole contract.
    #[tokio::test]
    async fn endpoints_built_here_reach_each_other() {
        const ALPN: &[u8] = b"depot/iroh-boring/test";

        let server = builder()
            .alpns(vec![ALPN.to_vec()])
            .bind()
            .await
            .expect("binding the server");
        let client = builder().bind().await.expect("binding the client");
        let addr = iroh_utils::dialable_addr(&server);

        let accepting = tokio::spawn(async move {
            let incoming = server.accept().await.expect("the endpoint closed");
            let conn = incoming.await.expect("accepting");
            let (mut send, mut recv) = conn.accept_bi().await.expect("accepting a stream");
            let payload = recv.read_to_end(64).await.expect("reading");
            send.write_all(&payload).await.expect("writing");
            send.finish().expect("finishing");
            conn.closed().await;
        });

        let conn = client.connect(addr, ALPN).await.expect("connecting");
        let (mut send, mut recv) = conn.open_bi().await.expect("opening a stream");
        send.write_all(b"over boringssl").await.expect("writing");
        send.finish().expect("finishing");
        assert_eq!(
            recv.read_to_end(64).await.expect("reading"),
            b"over boringssl"
        );
        conn.close(iroh_utils::CLOSE_DONE, b"done");
        client.close().await;
        accepting.await.expect("the accepting side panicked");
    }
}
