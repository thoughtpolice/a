// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! gRPC over iroh: each QUIC stream after the handshake carries one
//! HTTP/2 connection, so neither tonic nor the host's services know they
//! are not on TCP.

use std::time::Duration;

use iroh::endpoint::{Connection, QuicTransportConfig, RecvStream, SendStream, VarInt};
use iroh::{Endpoint, SecretKey};
use tonic::transport::Channel;

use crate::Protocol;
use crate::keys::JoinKey;

/// One HTTP/2 connection's worth of QUIC stream.
pub type Stream = tokio::io::Join<RecvStream, SendStream>;

/// How endpoints of a mesh use QUIC.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Transport {
    /// Streams a member may hold open at once on one connection to a
    /// host. Each gRPC channel takes one, and a reconnecting channel
    /// another.
    pub max_member_streams: u32,
    /// Bytes in flight per stream.
    pub stream_window: u32,
    /// Bytes in flight per connection.
    pub connection_window: u32,
    /// How often an idle connection says something, so neither end, nor
    /// a NAT between them, forgets it.
    pub keep_alive: Duration,
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
    /// every stream they open afterwards, to serve gRPC on. Ends when the
    /// endpoint closes or the source is dropped.
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
                        if streams.send(tokio::io::join(recv, send)).await.is_err() {
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

/// A gRPC channel to the host at the other end of `conn`, which this
/// member has joined. Each HTTP/2 connection the channel makes is a new
/// stream of `conn`; once `conn` closes, the channel fails.
pub fn channel(conn: Connection, transport: &Transport) -> Channel {
    // The authority is never resolved: every connection is a stream of
    // `conn`.
    tonic::transport::Endpoint::from_static("http://mesh.iroh")
        .initial_connection_window_size(Some(transport.connection_window))
        .initial_stream_window_size(Some(transport.stream_window))
        .connect_with_connector_lazy(tower::service_fn(move |_: tonic::transport::Uri| {
            let conn = conn.clone();
            async move {
                let (send, recv) = conn.open_bi().await.map_err(std::io::Error::other)?;
                Ok::<_, std::io::Error>(hyper_util::rt::TokioIo::new(tokio::io::join(recv, send)))
            }
        }))
}
