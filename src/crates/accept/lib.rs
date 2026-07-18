// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: MIT OR Apache-2.0

//! The transport-neutral accept abstraction: a source of established
//! duplex byte streams, with no opinion about what is served over them.
//!
//! [`Accept`] is implemented here for [`TcpListener`]. Wrappers add
//! behavior over any source (e.g. `rustls-transport` for TLS
//! termination), and servers (e.g. `dial9-tonic`) drive one generically —
//! anything that can hand out `AsyncRead + AsyncWrite` streams (a
//! QUIC/iroh endpoint, an in-memory pipe, a Unix socket listener) plugs
//! into the same loop.

use std::future::Future;

use tokio::io::{AsyncRead, AsyncWrite};
use tokio::net::{TcpListener, TcpStream};

/// A source of accepted, ready-to-serve duplex byte streams.
///
/// Each yielded stream carries one connection. Transport-specific socket
/// setup belongs in the implementation, which also decides what is fatal:
/// an error from [`accept`](Accept::accept) stops the caller's accept
/// loop, so per-peer failures (say, one bad handshake) must be swallowed
/// rather than returned.
///
/// Returning `Ok(None)` means the source is exhausted (e.g. the endpoint
/// behind it closed): the caller should stop accepting, let live
/// connections finish, and wind down cleanly.
pub trait Accept {
    /// The duplex stream produced for each accepted connection.
    type Io: AsyncRead + AsyncWrite + Unpin + Send + 'static;

    /// Waits for the next connection.
    fn accept(&mut self) -> impl Future<Output = std::io::Result<Option<Self::Io>>> + Send;
}

impl Accept for TcpListener {
    type Io = TcpStream;

    async fn accept(&mut self) -> std::io::Result<Option<TcpStream>> {
        let (stream, _addr) = TcpListener::accept(self).await?;
        // A failure here means the peer is already gone (reset between
        // accept and setsockopt); serving the doomed stream is harmless,
        // and per the Accept contract it must not stop the server.
        if let Err(_err) = stream.set_nodelay(true) {
            tracing::trace!("failed to set TCP_NODELAY: {_err}");
        }
        Ok(Some(stream))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};

    #[tokio::test]
    async fn tcp_listener_yields_nodelay_streams() {
        let mut listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let addr = listener.local_addr().expect("local addr");

        let client = tokio::spawn(async move {
            let mut stream = TcpStream::connect(addr).await.expect("connect");
            stream.write_all(b"ping").await.expect("write");
            let mut buf = [0u8; 4];
            stream.read_exact(&mut buf).await.expect("read");
            assert_eq!(&buf, b"pong");
        });

        let mut stream = Accept::accept(&mut listener)
            .await
            .expect("accept")
            .expect("a connection, not exhaustion");
        assert!(stream.nodelay().expect("query nodelay"));

        let mut buf = [0u8; 4];
        stream.read_exact(&mut buf).await.expect("read");
        assert_eq!(&buf, b"ping");
        stream.write_all(b"pong").await.expect("write");
        client.await.expect("client task");
    }
}
