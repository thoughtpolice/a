// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! gRPC over iroh: each QUIC stream after the handshake carries one
//! HTTP/2 connection, so neither tonic nor the daemon's services know they
//! are not on TCP.

use std::time::Duration;

use iroh::endpoint::{Connection, QuicTransportConfig, RecvStream, SendStream, VarInt};
use iroh::{Endpoint, SecretKey};
use tonic::transport::Channel;

use crate::ALPN;
use crate::join::admit;
use crate::keys::JoinKey;

/// One HTTP/2 connection's worth of QUIC stream.
pub type Stream = tokio::io::Join<RecvStream, SendStream>;

/// Streams a worker may hold open at once on one connection. Each gRPC
/// channel takes one, and a reconnecting channel another.
const MAX_WORKER_STREAMS: u32 = 1024;

/// Bytes in flight per stream, and per connection: enough to keep a link
/// of a few hundred Mbit/s busy across an ocean while blobs stream.
const STREAM_WINDOW: u32 = 16 * 1024 * 1024;
const CONNECTION_WINDOW: u32 = 64 * 1024 * 1024;

/// An endpoint with identity `secret_key`, found and reached as `preset`
/// says. A daemon's accepts workers; a worker's accepts nothing.
pub async fn bind(
    secret_key: SecretKey,
    daemon: bool,
    preset: iroh_dial::Global,
) -> Result<Endpoint, iroh::endpoint::BindError> {
    let transport = QuicTransportConfig::builder()
        .max_concurrent_bidi_streams(VarInt::from_u32(if daemon {
            MAX_WORKER_STREAMS
        } else {
            0
        }))
        .max_concurrent_uni_streams(VarInt::from_u32(0))
        .stream_receive_window(VarInt::from_u32(STREAM_WINDOW))
        .receive_window(VarInt::from_u32(CONNECTION_WINDOW))
        .send_window(u64::from(CONNECTION_WINDOW))
        // A worker waiting for work says nothing for minutes at a time.
        .keep_alive_interval(Duration::from_secs(10))
        .build();
    let mut builder = iroh_boring::builder()
        .secret_key(secret_key)
        .preset(preset)
        .transport_config(transport);
    if daemon {
        builder = builder.alpns(vec![ALPN.to_vec()]);
    }
    builder.bind().await
}

/// Admit workers that join `endpoint` with one of `keys`, and hand over
/// every stream they open afterwards, to serve gRPC on. Ends when the
/// endpoint closes or the source is dropped.
pub fn serve(endpoint: Endpoint, keys: Vec<JoinKey>) -> accept::Handover<Stream> {
    let (streams, handover) = accept::Handover::new();
    tokio::spawn(async move {
        let keys = std::sync::Arc::new(keys);
        while let Some(incoming) = endpoint.accept().await {
            let (streams, keys, me) = (streams.clone(), keys.clone(), endpoint.id());
            tokio::spawn(async move {
                let conn = match incoming.await {
                    Ok(conn) => conn,
                    Err(e) => {
                        tracing::debug!("a worker's connection failed: {e}");
                        return;
                    }
                };
                let worker = conn.remote_id();
                if let Err(e) = admit(&conn, me, &keys).await {
                    // Anyone can reach this, so it is not worth more than a
                    // debug line.
                    tracing::debug!(%worker, "refused a worker: {e}");
                    return;
                }
                tracing::info!(%worker, "a worker joined");
                while let Ok((send, recv)) = conn.accept_bi().await {
                    if streams.send(tokio::io::join(recv, send)).await.is_err() {
                        conn.close(VarInt::from_u32(0), b"the daemon is stopping");
                        return;
                    }
                }
                tracing::info!(%worker, "a worker left");
            });
        }
    });
    handover
}

/// A gRPC channel to the daemon at the other end of `conn`, which this
/// worker has joined. Each HTTP/2 connection the channel makes is a new
/// stream of `conn`; once `conn` closes, the channel fails.
pub fn channel(conn: Connection) -> Channel {
    tonic::transport::Endpoint::from_static("http://gonzo.iroh")
        .initial_connection_window_size(Some(CONNECTION_WINDOW))
        .initial_stream_window_size(Some(STREAM_WINDOW))
        .connect_with_connector_lazy(tower::service_fn(move |_: tonic::transport::Uri| {
            let conn = conn.clone();
            async move {
                let (send, recv) = conn.open_bi().await.map_err(std::io::Error::other)?;
                Ok::<_, std::io::Error>(hyper_util::rt::TokioIo::new(tokio::io::join(recv, send)))
            }
        }))
}
