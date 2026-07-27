// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: MIT OR Apache-2.0

//! Traced gRPC server: routes every per-connection and HTTP/2-internal spawn
//! through [`Dial9TokioHandle::spawn`] so that scheduling delays are captured
//! by the dial9 telemetry system.
//!
//! Adapted from the dial9 `axum_traced.rs` example for tonic services.
//!
//! The accept loop is generic over [`Accept`], so the same traced serving
//! path runs over TCP or any other source of duplex byte streams — TLS
//! (`rustls-transport`), an in-memory pipe, or QUIC/iroh streams bridged
//! into HTTP/2.

use std::{future::Future, pin::pin, time::Duration};

use dial9::Dial9TokioHandle;
use futures::FutureExt as _;
use hyper::body::Incoming;
use hyper_util::{
    rt::{TokioIo, TokioTimer},
    server::conn::auto::Builder,
    service::TowerToHyperService,
};
use tokio::sync::watch;
use tower::Service;

pub use accept::Accept;

// -------------------------------------------------------------------------------------------------

/// A hyper executor that routes spawns through dial9's [`Dial9TokioHandle`]
/// so HTTP/2 internal tasks get wake event tracking.
#[derive(Clone)]
struct TracedExecutor {
    handle: Dial9TokioHandle,
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

/// Serve a tower [`Service`] over an [`Accept`] source with traced spawning.
///
/// Every accepted connection is spawned via `handle.spawn()` and hyper's
/// internal HTTP/2 tasks use a [`TracedExecutor`] — giving full scheduling
/// delay visibility to the telemetry system.
pub async fn serve_traced<A, S, ResBody>(
    mut acceptor: A,
    service: S,
    handle: Dial9TokioHandle,
    shutdown: impl Future<Output = ()> + Send + 'static,
) -> Result<(), Box<dyn std::error::Error>>
where
    A: Accept,
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
        let stream = tokio::select! {
            conn = acceptor.accept() => match conn? {
                Some(stream) => stream,
                None => break,
            },
            _ = signal_tx.closed() => break,
        };

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
                .keep_alive_timeout(Duration::from_secs(30))
                .max_concurrent_streams(Some(256));

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
    drop(acceptor);
    close_tx.closed().await;
    Ok(())
}

// -------------------------------------------------------------------------------------------------

/// Helpers shared by the transport tests here and in [`tls`].
#[cfg(test)]
pub(crate) mod test_support {
    use super::*;

    use std::convert::Infallible;

    use bytes::Bytes;
    use dial9::RecorderTokioExt as _;
    use http_body_util::{BodyExt as _, Full};
    use hyper_util::rt::TokioExecutor;
    use tokio::io::{AsyncRead, AsyncWrite};

    pub(crate) async fn hello(
        _req: hyper::Request<Incoming>,
    ) -> Result<hyper::Response<Full<Bytes>>, Infallible> {
        Ok(hyper::Response::new(Full::new(Bytes::from_static(
            b"hello",
        ))))
    }

    /// Run `body` on a runtime attached to a disabled recorder and tear it down.
    ///
    /// A disabled recorder attaches a plain, unmodified tokio runtime, and
    /// `Dial9TokioHandle::current()` hands back an inert handle whose `spawn`
    /// falls through to `tokio::spawn` — the same shape production takes when
    /// tracing is switched off.
    pub(crate) fn block_on_traced<F, Fut>(body: F)
    where
        F: FnOnce(Dial9TokioHandle) -> Fut,
        Fut: Future<Output = ()>,
    {
        let (recorder, runtime) = dial9::recorder_disabled()
            .attach_tokio_runtime(|_| {})
            .expect("build runtime");
        runtime.block_on(body(Dial9TokioHandle::current()));
        drop(runtime);
        recorder.graceful_shutdown(std::time::Duration::from_secs(5));
    }

    /// Handshake HTTP/2 over `io`, run one request against [`hello`], and
    /// wind the client connection down.
    pub(crate) async fn roundtrip_hello<T>(io: T)
    where
        T: AsyncRead + AsyncWrite + Unpin + Send + 'static,
    {
        let (mut send, conn) =
            hyper::client::conn::http2::handshake(TokioExecutor::new(), TokioIo::new(io))
                .await
                .expect("http2 handshake");
        let conn = tokio::spawn(conn);

        let req = hyper::Request::builder()
            .uri("http://test/")
            .body(Full::new(Bytes::new()))
            .expect("build request");
        let resp = send.send_request(req).await.expect("send request");
        assert_eq!(resp.status(), hyper::StatusCode::OK);
        let body = resp.into_body().collect().await.expect("read body");
        assert_eq!(&body.to_bytes()[..], b"hello");

        drop(send);
        let _ = conn.await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    use tokio::io::DuplexStream;
    use tokio::net::{TcpListener, TcpStream};
    use tokio::sync::{mpsc, oneshot};

    use crate::test_support::{block_on_traced, hello, roundtrip_hello};

    /// An [`Accept`] source fed by hand with in-memory pipes — the same
    /// shape a non-TCP transport (e.g. iroh streams) presents.
    struct ChannelAcceptor(mpsc::Receiver<DuplexStream>);

    impl Accept for ChannelAcceptor {
        type Io = DuplexStream;

        async fn accept(&mut self) -> std::io::Result<Option<DuplexStream>> {
            Ok(self.0.recv().await)
        }
    }

    #[test]
    fn serves_http2_over_in_memory_duplex() {
        block_on_traced(|handle| async move {
            let (conn_tx, conn_rx) = mpsc::channel(4);
            let (shutdown_tx, shutdown_rx) = oneshot::channel::<()>();

            let server = serve_traced(
                ChannelAcceptor(conn_rx),
                tower::service_fn(hello),
                handle,
                async move {
                    let _ = shutdown_rx.await;
                },
            );

            let client = async move {
                // "Dial" by handing the server one end of a pipe.
                let (client_io, server_io) = tokio::io::duplex(64 * 1024);
                conn_tx.send(server_io).await.expect("acceptor gone");
                roundtrip_hello(client_io).await;
                shutdown_tx.send(()).expect("server exited early");
            };

            let (result, ()) = tokio::join!(server, client);
            result.expect("serve_traced failed");
        });
    }

    /// The production TCP path: a real listener on loopback exercises the
    /// [`TcpListener`] impl of [`Accept`], and shutdown must come from the
    /// signal — a TCP source never reports exhaustion.
    #[test]
    fn serves_http2_over_tcp_loopback() {
        block_on_traced(|handle| async move {
            let listener = TcpListener::bind("127.0.0.1:0")
                .await
                .expect("bind loopback");
            let addr = listener.local_addr().expect("local addr");
            let (shutdown_tx, shutdown_rx) = oneshot::channel::<()>();

            let server = serve_traced(listener, tower::service_fn(hello), handle, async move {
                let _ = shutdown_rx.await;
            });

            let client = async move {
                let stream = TcpStream::connect(addr).await.expect("connect to server");
                roundtrip_hello(stream).await;
                shutdown_tx.send(()).expect("server exited early");
            };

            let (result, ()) = tokio::join!(server, client);
            result.expect("serve_traced failed");
        });
    }
}
