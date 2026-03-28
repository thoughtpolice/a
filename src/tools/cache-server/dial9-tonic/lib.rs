// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: MIT OR Apache-2.0

//! Traced gRPC server: routes every per-connection and HTTP/2-internal spawn
//! through [`TelemetryHandle::spawn`] so that scheduling delays are captured
//! by the dial9 telemetry system.
//!
//! Adapted from the dial9 `axum_traced.rs` example for tonic services.

use std::{future::Future, pin::pin, time::Duration};

use dial9_tokio_telemetry::telemetry::TelemetryHandle;
use futures::FutureExt as _;
use hyper::body::Incoming;
use hyper_util::{
    rt::{TokioIo, TokioTimer},
    server::conn::auto::Builder,
    service::TowerToHyperService,
};
use tokio::{net::TcpListener, sync::watch};
use tower::Service;

// -------------------------------------------------------------------------------------------------

/// A hyper executor that routes spawns through dial9's [`TelemetryHandle`]
/// so HTTP/2 internal tasks get wake event tracking.
#[derive(Clone)]
struct TracedExecutor {
    handle: TelemetryHandle,
}

impl<Fut> hyper::rt::Executor<Fut> for TracedExecutor
where
    Fut: Future + Send + 'static,
    Fut::Output: Send + 'static,
{
    fn execute(&self, fut: Fut) {
        self.handle.spawn(fut);
    }
}

// -------------------------------------------------------------------------------------------------

/// Serve a tower [`Service`] over TCP with traced spawning.
///
/// Every accepted connection is spawned via `handle.spawn()` and hyper's
/// internal HTTP/2 tasks use a [`TracedExecutor`] — giving full scheduling
/// delay visibility to the telemetry system.
pub async fn serve_traced<S, ResBody>(
    listener: TcpListener,
    service: S,
    handle: TelemetryHandle,
    shutdown: impl Future<Output = ()> + Send + 'static,
) -> Result<(), Box<dyn std::error::Error>>
where
    S: Service<hyper::Request<Incoming>, Response = hyper::Response<ResBody>>
        + Clone
        + Send
        + 'static,
    S::Error: Into<Box<dyn std::error::Error + Send + Sync>>,
    S::Future: Send,
    ResBody: hyper::body::Body<Data = bytes::Bytes> + Send + 'static,
    ResBody::Error: Into<Box<dyn std::error::Error + Send + Sync>>,
{
    let (signal_tx, signal_rx) = watch::channel(());
    handle.spawn(async move {
        shutdown.await;
        drop(signal_rx);
    });

    let (close_tx, close_rx) = watch::channel(());

    loop {
        let (stream, _addr) = tokio::select! {
            conn = listener.accept() => conn?,
            _ = signal_tx.closed() => break,
        };

        stream.set_nodelay(true)?;

        let io = TokioIo::new(stream);
        let svc = service.clone();
        let hyper_service = TowerToHyperService::new(svc);
        let signal_tx = signal_tx.clone();
        let close_rx = close_rx.clone();
        let traced_handle = handle.clone();

        handle.spawn(async move {
            let mut builder = Builder::new(TracedExecutor {
                handle: traced_handle,
            });

            // HTTP/2 settings — replicate the previous tonic::transport::Server config.
            builder
                .http2()
                .timer(TokioTimer::new())
                .initial_connection_window_size(16 * 1024 * 1024) // 16 MiB
                .initial_stream_window_size(8 * 1024 * 1024) // 8 MiB
                .adaptive_window(true)
                .max_frame_size(1024 * 1024) // 1 MiB
                .keep_alive_interval(Some(Duration::from_secs(30)))
                .keep_alive_timeout(Duration::from_secs(10));

            let conn = builder.serve_connection_with_upgrades(io, hyper_service);
            let mut conn = pin!(conn);
            let mut signal_closed = pin!(signal_tx.closed().fuse());

            loop {
                tokio::select! {
                    result = conn.as_mut() => {
                        if let Err(_err) = result {
                            tracing::trace!("failed to serve connection: {_err:#}");
                        }
                        break;
                    }
                    _ = &mut signal_closed => {
                        conn.as_mut().graceful_shutdown();
                    }
                }
            }
            drop(close_rx);
        });
    }

    drop(close_rx);
    drop(listener);
    close_tx.closed().await;
    Ok(())
}
