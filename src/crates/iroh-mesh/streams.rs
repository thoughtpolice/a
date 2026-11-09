// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! A mesh's endpoints, and the streams its members open: after the join
//! handshake, every stream a member opens on its connection is the
//! application's, to carry what it likes (gonzo's workers carry one HTTP/2
//! connection each, for gRPC; quad's clients the editor's protocol).

use std::pin::Pin;
use std::task::{Context, Poll};
use std::time::Duration;

use iroh::endpoint::{Connection, QuicTransportConfig, RecvStream, SendStream, VarInt};
use iroh::{Endpoint, SecretKey};
use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};

use crate::Protocol;
use crate::keys::JoinKey;

/// A stream a joined member opened, both ways, and the connection it came
/// on: for what else the application sends that member besides streams
/// (datagrams, say).
pub struct Stream {
    io: tokio::io::Join<RecvStream, SendStream>,
    connection: Connection,
}

impl Stream {
    /// The member's connection, which this stream is one of.
    pub fn connection(&self) -> &Connection {
        &self.connection
    }
}

impl AsyncRead for Stream {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<std::io::Result<()>> {
        Pin::new(&mut self.io).poll_read(cx, buf)
    }
}

impl AsyncWrite for Stream {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<std::io::Result<usize>> {
        Pin::new(&mut self.io).poll_write(cx, buf)
    }

    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        Pin::new(&mut self.io).poll_flush(cx)
    }

    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        Pin::new(&mut self.io).poll_shutdown(cx)
    }
}

/// How endpoints of a mesh use QUIC.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Transport {
    /// Streams a member may hold open at once on one connection to a
    /// host. (A gRPC channel over the mesh takes one, and a reconnecting
    /// channel another.)
    pub max_member_streams: u32,
    /// Bytes in flight per stream.
    pub stream_window: u32,
    /// Bytes in flight per connection.
    pub connection_window: u32,
    /// How often an idle connection says something, so neither end, nor
    /// a NAT between them, forgets it.
    pub keep_alive: Duration,
    /// How long a connection that hears nothing from the other end lives:
    /// how soon an end that went away without a word (killed, or off the
    /// network) is noticed. Longer than `keep_alive`; the shorter of the
    /// two ends' applies.
    pub idle_timeout: Duration,
}

impl Default for Transport {
    /// Windows that keep a link of a few hundred Mbit/s busy across an
    /// ocean while bulk data streams, and a keep-alive for members that
    /// wait minutes between requests.
    fn default() -> Self {
        Self {
            max_member_streams: 1024,
            stream_window: 16 * 1024 * 1024,
            connection_window: 64 * 1024 * 1024,
            keep_alive: Duration::from_secs(10),
            idle_timeout: Duration::from_secs(30),
        }
    }
}

impl Transport {
    fn config(&self, accepted_streams: u32) -> QuicTransportConfig {
        QuicTransportConfig::builder()
            .max_concurrent_bidi_streams(VarInt::from_u32(accepted_streams))
            .max_concurrent_uni_streams(VarInt::from_u32(0))
            .stream_receive_window(VarInt::from_u32(self.stream_window))
            .receive_window(VarInt::from_u32(self.connection_window))
            .send_window(u64::from(self.connection_window))
            .keep_alive_interval(self.keep_alive)
            .max_idle_timeout(self.idle_timeout.try_into().ok())
            .build()
    }
}

impl Protocol {
    /// A host's endpoint, with identity `secret_key`, found and reached as
    /// `preset` says, accepting members on the protocol's ALPN.
    pub async fn bind_host(
        &self,
        secret_key: SecretKey,
        preset: iroh_dial::Global,
        transport: &Transport,
    ) -> Result<Endpoint, iroh::endpoint::BindError> {
        iroh_boring::builder()
            .secret_key(secret_key)
            .preset(preset)
            .transport_config(transport.config(transport.max_member_streams))
            .alpns(vec![self.alpn.to_vec()])
            .bind()
            .await
    }

    /// A member's endpoint, with identity `secret_key`, found and reached
    /// as `preset` says. It accepts nothing: members dial.
    pub async fn bind_member(
        &self,
        secret_key: SecretKey,
        preset: iroh_dial::Global,
        transport: &Transport,
    ) -> Result<Endpoint, iroh::endpoint::BindError> {
        iroh_boring::builder()
            .secret_key(secret_key)
            .preset(preset)
            .transport_config(transport.config(0))
            .bind()
            .await
    }

    /// Admit members that join `endpoint` with one of `keys`, and hand over
    /// every stream they open afterwards, to serve whatever the application
    /// speaks on. Ends when the endpoint closes or the source is dropped.
    pub fn serve(&self, endpoint: Endpoint, keys: Vec<JoinKey>) -> accept::Handover<Stream> {
        let (streams, handover) = accept::Handover::new();
        let protocol = *self;
        tokio::spawn(async move {
            let keys = std::sync::Arc::new(keys);
            while let Some(incoming) = endpoint.accept().await {
                let (streams, keys, me) = (streams.clone(), keys.clone(), endpoint.id());
                tokio::spawn(async move {
                    let conn = match incoming.await {
                        Ok(conn) => conn,
                        Err(e) => {
                            tracing::debug!("a member's connection failed: {e}");
                            return;
                        }
                    };
                    let member = conn.remote_id();
                    if let Err(e) = protocol.admit(&conn, me, &keys).await {
                        // Anyone can reach this, so it is not worth more
                        // than a debug line.
                        tracing::debug!(%member, role = protocol.member, "refused a member: {e}");
                        return;
                    }
                    tracing::info!(%member, role = protocol.member, "a member joined");
                    while let Ok((send, recv)) = conn.accept_bi().await {
                        let stream = Stream {
                            io: tokio::io::join(recv, send),
                            connection: conn.clone(),
                        };
                        if streams.send(stream).await.is_err() {
                            conn.close(VarInt::from_u32(0), b"the host is stopping");
                            return;
                        }
                    }
                    tracing::info!(%member, role = protocol.member, "a member left");
                });
            }
        });
        handover
    }
}
