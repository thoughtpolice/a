// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! Cancellation-safe Burrow byte-stream forwarding.

use std::pin::pin;
use std::time::Duration;

use anyhow::{Context, Result};
use iroh::endpoint::{RecvStream, SendStream, VarInt};
use tokio::io::{AsyncRead, AsyncWrite, AsyncWriteExt};
use tokio::net::TcpStream;

/// Stream reset code used when one direction of a forwarding operation fails.
///
/// Dropping a noq send stream implicitly finishes it.  That clean finish is
/// wrong after a failed or cancelled copy because it makes a truncated byte
/// stream indistinguishable from a complete one.  Burrow explicitly resets or
/// stops both QUIC halves with this code instead.
pub const RESET_ABORTED: VarInt = VarInt::from_u32(3);

/// Whether EOF received from the tunnel can be represented by the local
/// writer.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LocalEof {
    /// The local stream supports a write-half shutdown, as TCP does.  Both copy
    /// directions therefore run until each independently reaches EOF.
    HalfClose,
    /// The local writer cannot expose EOF, as is the case for process stdout.
    /// End the whole splice when the tunnel's receive half reaches EOF.
    EndTunnel,
}

/// Owns both halves until the splice has completed cleanly.
///
/// The guard is deliberately constructed outside the returned async block in
/// [`splice`].  That makes even an unpolled splice future cancellation-safe:
/// dropping it cannot fall back to noq's implicit clean stream shutdown.
struct StreamAbortGuard {
    send: SendStream,
    recv: RecvStream,
    armed: bool,
}

impl StreamAbortGuard {
    fn new(send: SendStream, recv: RecvStream) -> Self {
        Self {
            send,
            recv,
            armed: true,
        }
    }

    fn streams_mut(&mut self) -> (&mut SendStream, &mut RecvStream) {
        (&mut self.send, &mut self.recv)
    }

    fn abort(&mut self) {
        if !std::mem::replace(&mut self.armed, false) {
            return;
        }
        let _ = self.send.reset(RESET_ABORTED);
        let _ = self.recv.stop(RESET_ABORTED);
    }

    fn disarm(&mut self) {
        self.armed = false;
    }
}

impl Drop for StreamAbortGuard {
    fn drop(&mut self) {
        self.abort();
    }
}

/// Couples stream cancellation with arbitrary state that must outlive it.
///
/// The explicit Drop implementation establishes an order that field drop
/// order alone cannot express robustly: reset/stop the QUIC halves first, then
/// release the client/connection keepalive used by OpenedStream's consuming
/// splice methods.
struct SpliceResources<K> {
    streams: StreamAbortGuard,
    keepalive: K,
}

impl<K> SpliceResources<K> {
    fn new(send: SendStream, recv: RecvStream, keepalive: K) -> Self {
        Self {
            streams: StreamAbortGuard::new(send, recv),
            keepalive,
        }
    }
}

impl<K> Drop for SpliceResources<K> {
    fn drop(&mut self) {
        self.streams.abort();
    }
}

/// Copies both directions between a local byte stream and a QUIC stream pair.
///
/// In [`LocalEof::HalfClose`] mode, one clean half-close does not cancel the
/// other direction.  If either direction fails, however, the other future is
/// cancelled and both QUIC halves are explicitly marked with
/// [`RESET_ABORTED`].  This is important: noq otherwise gives a dropped
/// [`SendStream`] an implicit clean FIN and a dropped [`RecvStream`] a generic
/// stop code, hiding truncation from the peer.
///
/// Dropping the returned future at any point, including before its first poll,
/// also resets and stops the two tunnel halves with [`RESET_ABORTED`].
pub fn splice<R, W>(
    local_read: R,
    local_write: W,
    send: SendStream,
    recv: RecvStream,
    local_eof: LocalEof,
) -> impl std::future::Future<Output = Result<()>>
where
    R: AsyncRead + Unpin,
    W: AsyncWrite + Unpin,
{
    splice_with_keepalive(local_read, local_write, send, recv, local_eof, ())
}

/// Internal form of splice that retains ownership state for the entire
/// forwarding operation.
pub(crate) fn splice_with_keepalive<R, W, K>(
    local_read: R,
    local_write: W,
    send: SendStream,
    recv: RecvStream,
    local_eof: LocalEof,
    keepalive: K,
) -> impl std::future::Future<Output = Result<()>>
where
    R: AsyncRead + Unpin,
    W: AsyncWrite + Unpin,
{
    splice_with_reporter(
        local_read,
        local_write,
        send,
        recv,
        local_eof,
        keepalive,
        None,
        |_, _| {},
    )
}

/// Internal form which can wait for the peer to acknowledge a clean FIN and
/// report the final result through retained ownership state.
///
/// `report` runs only when the future itself completes. If it is cancelled,
/// [`SpliceResources::drop`] aborts the QUIC halves before dropping
/// `keepalive`, allowing the keepalive's Drop implementation to report
/// cancellation without racing a misleading clean FIN.
pub(crate) fn splice_with_reporter<R, W, K, F>(
    mut local_read: R,
    mut local_write: W,
    send: SendStream,
    recv: RecvStream,
    local_eof: LocalEof,
    keepalive: K,
    wait_for_stop: Option<Duration>,
    report: F,
) -> impl std::future::Future<Output = Result<()>>
where
    R: AsyncRead + Unpin,
    W: AsyncWrite + Unpin,
    F: FnOnce(&mut K, &Result<()>),
{
    // Construct this synchronously, outside the async block, so cancelling an
    // unpolled future still invokes the aborting Drop implementation.
    let mut resources = SpliceResources::new(send, recv, keepalive);
    async move {
        let mut result = {
            let (send, recv) = resources.streams.streams_mut();
            let outbound = async {
                match tokio::io::copy(&mut local_read, send).await {
                    Ok(_) => send.shutdown().await.context("finishing the tunnel stream"),
                    Err(err) => {
                        // This direction's remaining bytes will never arrive.
                        // Reset it before yielding so EndTunnel mode can
                        // continue draining the other direction without making
                        // the peer wait for a FIN.
                        let _ = send.reset(RESET_ABORTED);
                        Err(err).context("copying into the tunnel")
                    }
                }
            };
            let inbound = async {
                match tokio::io::copy(recv, &mut local_write).await {
                    Ok(_) => {
                        if local_eof == LocalEof::HalfClose {
                            local_write
                                .shutdown()
                                .await
                                .context("closing the local stream")?;
                        }
                        Ok(())
                    }
                    Err(err) => {
                        // The local sink is gone, so tell the peer not to send
                        // more.
                        let _ = recv.stop(RESET_ABORTED);
                        Err(err).context("copying out of the tunnel")
                    }
                }
            };

            match local_eof {
                LocalEof::HalfClose => {
                    // Do not use try_join!: it drops the still-healthy
                    // direction on the first error while that future owns a
                    // QUIC half.  Keeping the streams in the outer guard lets
                    // us explicitly abort them once the losing future drops.
                    let mut outbound = pin!(outbound);
                    let mut inbound = pin!(inbound);
                    tokio::select! {
                        result = &mut outbound => match result {
                            Ok(()) => inbound.await,
                            Err(err) => Err(err),
                        },
                        result = &mut inbound => match result {
                            Ok(()) => outbound.await,
                            Err(err) => Err(err),
                        },
                    }
                }
                LocalEof::EndTunnel => {
                    let mut inbound = pin!(inbound);
                    tokio::select! {
                        // stdout cannot convey this EOF, so reaching it ends
                        // the process-style tunnel even if stdin remains
                        // blocked.
                        result = &mut inbound => result,
                        result = outbound => {
                            // Clean local EOF only half-closes the request. The
                            // remote may still owe a response, so keep draining
                            // it. A local read error is different: no useful
                            // progress can depend on an unresponsive peer, and
                            // the outer guard aborts both halves immediately.
                            match result {
                                Ok(()) => inbound.await,
                                Err(outbound_err) => Err(outbound_err),
                            }
                        }
                    }
                }
            }
        };

        if result.is_ok() {
            if local_eof == LocalEof::EndTunnel {
                // Make the clean cancellation of a still-blocked stdin future
                // explicit instead of relying on SendStream::drop to finish.
                let _ = resources.streams.send.finish();
            }
            if let Some(timeout) = wait_for_stop {
                result =
                    match tokio::time::timeout(timeout, resources.streams.send.stopped()).await {
                        Ok(Ok(None)) => Ok(()),
                        Ok(Ok(Some(code))) => Err(anyhow::anyhow!(
                            "the peer stopped the tunnel stream with code {code}"
                        )),
                        Ok(Err(err)) => Err(err)
                            .context("waiting for the peer to acknowledge the tunnel stream"),
                        Err(_) => Err(anyhow::anyhow!(
                            "the peer did not acknowledge the tunnel stream within {timeout:?}"
                        )),
                    };
            }
        }

        if result.is_ok() {
            resources.streams.disarm();
        } else {
            resources.streams.abort();
        }
        report(&mut resources.keepalive, &result);
        result
    }
}

/// Splices a TCP connection to a QUIC stream pair with correct TCP
/// half-closing semantics.
pub async fn splice_tcp(tcp: TcpStream, send: SendStream, recv: RecvStream) -> Result<()> {
    // Interactive protocols commonly make keystroke-sized writes.  Nagle can
    // otherwise add an avoidable round trip.
    let _ = tcp.set_nodelay(true);
    let (read, write) = tcp.into_split();
    splice(read, write, send, recv, LocalEof::HalfClose).await
}

#[cfg(test)]
#[path = "../tests/core/splice.rs"]
mod tests;
