// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

use super::*;

use std::io;
use std::pin::Pin;
use std::task::{Context as TaskContext, Poll};
use std::time::Duration;

use iroh::endpoint::{Connection, ReadError, ReadToEndError};
use iroh::{Endpoint, RelayMode};
use tokio::io::{AsyncRead, AsyncWrite, AsyncWriteExt, ReadBuf};

const TEST_ALPN: &[u8] = b"depot/burrow/splice-test";
const PATIENCE: Duration = Duration::from_secs(10);

struct StreamPair {
    server_endpoint: Endpoint,
    client_endpoint: Endpoint,
    server_connection: Connection,
    client_connection: Connection,
    client_send: Option<SendStream>,
    client_recv: Option<RecvStream>,
}

impl StreamPair {
    async fn new() -> Self {
        let server_endpoint = iroh_boring::builder()
            .relay_mode(RelayMode::Disabled)
            .alpns(vec![TEST_ALPN.to_vec()])
            .bind()
            .await
            .expect("binding the splice test server");
        let client_endpoint = iroh_boring::builder()
            .relay_mode(RelayMode::Disabled)
            .bind()
            .await
            .expect("binding the splice test client");
        let accepting_endpoint = server_endpoint.clone();
        let accepting = tokio::spawn(async move {
            accepting_endpoint
                .accept()
                .await
                .expect("the server endpoint stayed open")
                .await
                .expect("accepting the splice test connection")
        });
        let client_connection = client_endpoint
            .connect(iroh_utils::dialable_addr(&server_endpoint), TEST_ALPN)
            .await
            .expect("connecting the splice test client");
        let server_connection = accepting.await.expect("accept task panicked");
        let (client_send, client_recv) = client_connection
            .open_bi()
            .await
            .expect("opening the splice test stream");
        Self {
            server_endpoint,
            client_endpoint,
            server_connection,
            client_connection,
            client_send: Some(client_send),
            client_recv: Some(client_recv),
        }
    }

    async fn close(self) {
        self.client_connection
            .close(iroh_utils::CLOSE_DONE, b"test done");
        self.client_endpoint.close().await;
        self.server_endpoint.close().await;
    }
}

struct FailingRead;

impl AsyncRead for FailingRead {
    fn poll_read(
        self: Pin<&mut Self>,
        _cx: &mut TaskContext<'_>,
        _buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        Poll::Ready(Err(io::Error::other("injected local read failure")))
    }
}

struct FailingWrite;

impl AsyncWrite for FailingWrite {
    fn poll_write(
        self: Pin<&mut Self>,
        _cx: &mut TaskContext<'_>,
        _buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        Poll::Ready(Err(io::Error::other("injected local write failure")))
    }

    fn poll_flush(self: Pin<&mut Self>, _cx: &mut TaskContext<'_>) -> Poll<io::Result<()>> {
        Poll::Ready(Ok(()))
    }

    fn poll_shutdown(self: Pin<&mut Self>, _cx: &mut TaskContext<'_>) -> Poll<io::Result<()>> {
        Poll::Ready(Ok(()))
    }
}

async fn assert_peer_saw_both_aborts(mut send: SendStream, mut recv: RecvStream) {
    match tokio::time::timeout(PATIENCE, recv.read_to_end(1024))
        .await
        .expect("the peer receive half stayed pending")
    {
        Err(ReadToEndError::Read(ReadError::Reset(code))) => {
            assert_eq!(code, RESET_ABORTED)
        }
        other => panic!("expected reset {RESET_ABORTED}, got {other:?}"),
    }
    assert_eq!(
        tokio::time::timeout(PATIENCE, send.stopped())
            .await
            .expect("the peer send half stayed pending")
            .expect("checking whether the peer stopped the stream"),
        Some(RESET_ABORTED),
    );
}

#[tokio::test]
async fn local_read_failure_aborts_both_quic_halves() {
    let mut pair = StreamPair::new().await;
    let splice = tokio::spawn(splice(
        FailingRead,
        tokio::io::sink(),
        pair.client_send.take().expect("the client send half"),
        pair.client_recv.take().expect("the client receive half"),
        LocalEof::HalfClose,
    ));
    let (peer_send, peer_recv) = tokio::time::timeout(PATIENCE, pair.server_connection.accept_bi())
        .await
        .expect("the reset stream never reached the peer")
        .expect("accepting the reset stream");
    assert_peer_saw_both_aborts(peer_send, peer_recv).await;
    assert!(
        splice
            .await
            .expect("splice task panicked")
            .expect_err("the injected read failure must be returned")
            .to_string()
            .contains("copying into the tunnel")
    );
    pair.close().await;
}

#[tokio::test]
async fn end_tunnel_local_read_failure_does_not_wait_for_peer_eof() {
    let mut pair = StreamPair::new().await;
    let splice = tokio::spawn(splice(
        FailingRead,
        tokio::io::sink(),
        pair.client_send.take().expect("the client send half"),
        pair.client_recv.take().expect("the client receive half"),
        LocalEof::EndTunnel,
    ));
    let (peer_send, peer_recv) = tokio::time::timeout(PATIENCE, pair.server_connection.accept_bi())
        .await
        .expect("the reset stream never reached the peer")
        .expect("accepting the reset stream");

    let error = tokio::time::timeout(Duration::from_secs(1), splice)
        .await
        .expect("the local read error waited for peer EOF")
        .expect("splice task panicked")
        .expect_err("the injected read failure must be returned");
    assert!(error.to_string().contains("copying into the tunnel"));
    assert_peer_saw_both_aborts(peer_send, peer_recv).await;
    pair.close().await;
}

#[tokio::test]
async fn end_tunnel_clean_local_eof_keeps_draining_the_peer() {
    let mut pair = StreamPair::new().await;
    let splice = tokio::spawn(splice(
        tokio::io::empty(),
        tokio::io::sink(),
        pair.client_send.take().expect("the client send half"),
        pair.client_recv.take().expect("the client receive half"),
        LocalEof::EndTunnel,
    ));
    let (mut peer_send, mut peer_recv) =
        tokio::time::timeout(PATIENCE, pair.server_connection.accept_bi())
            .await
            .expect("the finished stream never reached the peer")
            .expect("accepting the finished stream");
    assert!(
        peer_recv.read_to_end(1024).await.unwrap().is_empty(),
        "the clean local EOF did not finish the send half"
    );
    tokio::task::yield_now().await;
    assert!(
        !splice.is_finished(),
        "clean local EOF stopped draining the peer response"
    );

    peer_send.write_all(b"response").await.unwrap();
    peer_send.shutdown().await.unwrap();
    tokio::time::timeout(PATIENCE, splice)
        .await
        .expect("the splice did not finish after peer EOF")
        .expect("splice task panicked")
        .expect("clean EndTunnel splice failed");
    pair.close().await;
}

#[tokio::test]
async fn local_write_failure_aborts_both_quic_halves() {
    let mut pair = StreamPair::new().await;
    pair.client_send
        .as_mut()
        .expect("the client send half")
        .write_all(b"make the stream visible")
        .await
        .expect("priming the stream");
    let (mut peer_send, peer_recv) = pair
        .server_connection
        .accept_bi()
        .await
        .expect("accepting the primed stream");
    let (idle_read, _keep_idle) = tokio::io::duplex(1);
    let splice = tokio::spawn(splice(
        idle_read,
        FailingWrite,
        pair.client_send.take().expect("the client send half"),
        pair.client_recv.take().expect("the client receive half"),
        LocalEof::HalfClose,
    ));
    peer_send
        .write_all(b"trigger the local writer")
        .await
        .expect("sending toward the failing writer");
    assert_peer_saw_both_aborts(peer_send, peer_recv).await;
    assert!(
        splice
            .await
            .expect("splice task panicked")
            .expect_err("the injected write failure must be returned")
            .to_string()
            .contains("copying out of the tunnel")
    );
    pair.close().await;
}

#[tokio::test]
async fn cancelling_splice_aborts_both_quic_halves() {
    let mut pair = StreamPair::new().await;
    pair.client_send
        .as_mut()
        .expect("the client send half")
        .write_all(b"make the stream visible")
        .await
        .expect("priming the stream");
    let (peer_send, peer_recv) = pair
        .server_connection
        .accept_bi()
        .await
        .expect("accepting the primed stream");

    // Keep both local halves open and idle so only cancellation can end the
    // splice.  In particular, this exercises Drop on the outer future
    // rather than either copy loop's ordinary error path.
    let (idle_read, keep_idle_read_open) = tokio::io::duplex(1);
    let splice = tokio::spawn(splice(
        idle_read,
        tokio::io::sink(),
        pair.client_send.take().expect("the client send half"),
        pair.client_recv.take().expect("the client receive half"),
        LocalEof::HalfClose,
    ));
    tokio::task::yield_now().await;
    splice.abort();
    assert!(
        splice
            .await
            .expect_err("the splice must be cancelled")
            .is_cancelled()
    );

    assert_peer_saw_both_aborts(peer_send, peer_recv).await;
    drop(keep_idle_read_open);
    pair.close().await;
}
