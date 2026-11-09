// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! gRPC over the mesh: each stream a worker opens on its connection to
//! the daemon carries one HTTP/2 connection, so neither tonic nor the
//! daemon's services know they are not on TCP. The daemon serves its
//! services on the streams [`Protocol::serve`](iroh_mesh::Protocol::serve)
//! hands it; a worker reaches them through a [`channel`].

use iroh::endpoint::Connection;
use iroh_mesh::Transport;
use tonic::transport::Channel;

/// A gRPC channel to the daemon at the other end of `conn`, which this
/// worker has joined. Each HTTP/2 connection the channel makes is a new
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
