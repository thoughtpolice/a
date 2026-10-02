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

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::{future::Future, pin::pin, time::Duration};

use dial9::Dial9TokioHandle;
use futures::FutureExt as _;
use hyper::body::Incoming;
use hyper_util::{
    rt::{TokioIo, TokioTimer},
    server::conn::auto::Builder,
    service::TowerToHyperService,
};
use tokio::sync::{Notify, watch};
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
    acceptor: A,
    service: S,
    handle: Dial9TokioHandle,
    shutdown: impl Future<Output = ()> + Send + 'static,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>>
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
    serve_traced_with(
        acceptor,
        service,
        handle,
        shutdown,
        ConnectionLimits::default(),
    )
    .await
}

/// How long a connection may go without a request.
#[derive(Clone, Debug)]
pub struct ConnectionLimits {
    /// A connection that has sent no request this long after it was
    /// accepted is closed. A peer that connects and sends nothing (or only
    /// the HTTP/2 preface) would otherwise hold its connection, and a slot
    /// of any connection cap, for good.
    pub first_request: Duration,
    /// A connection with no new request for this long is shut down
    /// gracefully: requests still in flight finish, and the client, told
    /// with a GOAWAY, reconnects when it next needs to.
    pub idle: Duration,
    /// Notified when a new connection is waiting for room, as an
    /// [`accept::Limited`] source's [`room_wanted`](accept::Limited::room_wanted)
    /// is at its cap. The connection that has gone longest without starting
    /// a request is then let go, as one past its limits would be: closed if
    /// it never sent a request, otherwise shut down gracefully. A cap
    /// filled by connections that hold on and do nothing would otherwise
    /// keep every newcomer waiting until they time out.
    pub make_room: Option<Arc<Notify>>,
}

impl Default for ConnectionLimits {
    fn default() -> Self {
        Self {
            first_request: Duration::from_secs(30),
            idle: Duration::from_secs(600),
            make_room: None,
        }
    }
}

/// When a connection last started a request.
struct Activity {
    accepted: tokio::time::Instant,
    /// Milliseconds after `accepted` of the latest request, plus one; zero
    /// before the first.
    last_request: AtomicU64,
    /// Asks the connection to go, to make room for another.
    evict: Notify,
    /// Whether it has been asked.
    evicted: AtomicBool,
}

impl Activity {
    fn new() -> Self {
        Self {
            accepted: tokio::time::Instant::now(),
            last_request: AtomicU64::new(0),
            evict: Notify::new(),
            evicted: AtomicBool::new(false),
        }
    }

    fn note_request(&self) {
        let at = self.accepted.elapsed().as_millis() as u64 + 1;
        self.last_request.store(at, Ordering::Relaxed);
    }

    /// When the connection last started a request, if it has.
    fn last_request(&self) -> Option<tokio::time::Instant> {
        match self.last_request.load(Ordering::Relaxed) {
            0 => None,
            at => Some(self.accepted + Duration::from_millis(at - 1)),
        }
    }

    /// When the connection last started a request, or failing that, was
    /// accepted.
    fn last_active(&self) -> tokio::time::Instant {
        self.last_request().unwrap_or(self.accepted)
    }
}

/// The connections being served, for choosing one to let go.
#[derive(Default)]
struct Connections {
    live: std::sync::Mutex<HashMap<u64, Arc<Activity>>>,
    next: AtomicU64,
}

/// A connection's place in [`Connections`], given up when dropped.
struct Registered {
    connections: Arc<Connections>,
    id: u64,
}

impl Drop for Registered {
    fn drop(&mut self) {
        self.connections.lock().remove(&self.id);
    }
}

impl Connections {
    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<u64, Arc<Activity>>> {
        self.live
            .lock()
            .expect("connection registry lock never poisoned")
    }

    fn register(self: &Arc<Self>, activity: Arc<Activity>) -> Registered {
        let id = self.next.fetch_add(1, Ordering::Relaxed);
        self.lock().insert(id, activity);
        Registered {
            connections: self.clone(),
            id,
        }
    }

    /// Ask the connection that has gone longest without starting a request,
    /// of those not asked already, to go. Returns whether there was one.
    fn evict_stalest(&self) -> bool {
        let stalest = self
            .lock()
            .values()
            .filter(|activity| !activity.evicted.load(Ordering::Relaxed))
            .min_by_key(|activity| activity.last_active())
            .cloned();
        let Some(activity) = stalest else {
            return false;
        };
        activity.evicted.store(true, Ordering::Relaxed);
        activity.evict.notify_one();
        true
    }
}

/// A connection's service, noting each request it starts.
#[derive(Clone)]
struct Tracked<S> {
    inner: S,
    activity: std::sync::Arc<Activity>,
}

impl<S, R> Service<R> for Tracked<S>
where
    S: Service<R>,
{
    type Response = S::Response;
    type Error = S::Error;
    type Future = S::Future;

    fn poll_ready(
        &mut self,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<Result<(), Self::Error>> {
        self.inner.poll_ready(cx)
    }

    fn call(&mut self, req: R) -> Self::Future {
        self.activity.note_request();
        self.inner.call(req)
    }
}

/// [`serve_traced`] with explicit [`ConnectionLimits`].
pub async fn serve_traced_with<A, S, ResBody>(
    mut acceptor: A,
    service: S,
    handle: Dial9TokioHandle,
    shutdown: impl Future<Output = ()> + Send + 'static,
    limits: ConnectionLimits,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>>
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

    let connections = Arc::new(Connections::default());
    // Lets a connection go each time room is wanted, until the server stops.
    let (evictor_tx, mut evictor_rx) = watch::channel(());
    if let Some(make_room) = limits.make_room.clone() {
        let connections = connections.clone();
        handle.spawn(async move {
            loop {
                tokio::select! {
                    _ = make_room.notified() => {
                        if !connections.evict_stalest() {
                            tracing::debug!("room wanted, but no connection left to let go");
                        }
                    }
                    _ = evictor_rx.changed() => break,
                }
            }
        });
    }

    loop {
        let stream = tokio::select! {
            conn = acceptor.accept() => match conn? {
                Some(stream) => stream,
                None => break,
            },
            _ = signal_tx.closed() => break,
        };

        let io = TokioIo::new(stream);
        let activity = std::sync::Arc::new(Activity::new());
        let svc = Tracked {
            inner: service.clone(),
            activity: activity.clone(),
        };
        let hyper_service = TowerToHyperService::new(svc);
        let signal_tx = signal_tx.clone();
        let close_rx = close_rx.clone();
        let traced_handle = handle.clone();
        let registered = connections.register(activity.clone());
        let (first_request, idle) = (limits.first_request, limits.idle);

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
            let mut shutting_down = false;

            loop {
                // The next moment the connection could be over its limit.
                let deadline = match activity.last_request() {
                    None => activity.accepted + first_request,
                    Some(last) => last + idle,
                };
                tokio::select! {
                    result = conn.as_mut() => {
                        if let Err(_err) = result {
                            tracing::trace!("failed to serve connection: {_err:#}");
                        }
                        break;
                    }
                    _ = &mut signal_closed, if !shutting_down => {
                        shutting_down = true;
                        conn.as_mut().graceful_shutdown();
                    }
                    _ = tokio::time::sleep_until(deadline), if !shutting_down => {
                        let due = match activity.last_request() {
                            None => activity.accepted + first_request,
                            Some(last) => last + idle,
                        };
                        if tokio::time::Instant::now() < due {
                            // A request came in meanwhile.
                            continue;
                        }
                        if activity.last_request().is_none() {
                            // Never a request, so nothing in flight: close.
                            tracing::debug!("closing a connection that sent no request");
                            break;
                        }
                        shutting_down = true;
                        conn.as_mut().graceful_shutdown();
                    }
                    _ = activity.evict.notified(), if !shutting_down => {
                        if activity.last_request().is_none() {
                            tracing::debug!("closing a connection that sent no request, to make room");
                            break;
                        }
                        tracing::debug!("shutting down the longest-idle connection, to make room");
                        shutting_down = true;
                        conn.as_mut().graceful_shutdown();
                    }
                }
            }
            drop(registered);
            drop(close_rx);
        });
    }

    drop(evictor_tx);
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
    use dial9::{Dial9HandleTokioExt as _, TokioAttachOptions};
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

    /// Run `body` on a runtime attached to a disabled recorder and tear it
    /// down. The spawn paths under test are the same either way; only the
    /// recording behind them is off.
    pub(crate) fn block_on_traced<F, Fut>(body: F)
    where
        F: FnOnce(Dial9TokioHandle) -> Fut,
        Fut: Future<Output = ()> + Send + 'static,
    {
        let mut builder = tokio::runtime::Builder::new_multi_thread();
        builder.enable_all();
        let recorder = dial9::recorder_disabled();
        let runtime = recorder
            .handle()
            .attach_tokio_runtime(builder, TokioAttachOptions::default())
            .expect("build runtime");
        // Capture the handle after the attach: that is what marks this thread
        // as traced, and before it `current()` is silently inert.
        dial9::block_on(&runtime, body(Dial9TokioHandle::current()));
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

    fn short_limits() -> ConnectionLimits {
        ConnectionLimits {
            first_request: Duration::from_millis(300),
            idle: Duration::from_millis(600),
            make_room: None,
        }
    }

    /// A peer that connects and sends nothing loses its connection once the
    /// first-request limit passes.
    #[test]
    fn a_silent_connection_is_closed() {
        block_on_traced(|handle| async move {
            use tokio::io::AsyncReadExt as _;
            let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
            let addr = listener.local_addr().expect("addr");
            let (shutdown_tx, shutdown_rx) = oneshot::channel::<()>();
            let server = tokio::spawn(serve_traced_with(
                listener,
                tower::service_fn(hello),
                handle,
                async move {
                    let _ = shutdown_rx.await;
                },
                short_limits(),
            ));

            let mut silent = TcpStream::connect(addr).await.expect("connect");
            let mut buf = vec![0u8; 4096];
            let closed = tokio::time::timeout(Duration::from_secs(5), async {
                // Whatever the server says first (its SETTINGS), then EOF.
                loop {
                    match silent.read(&mut buf).await {
                        Ok(0) | Err(_) => break,
                        Ok(_) => {}
                    }
                }
            })
            .await;
            assert!(closed.is_ok(), "the silent connection was not closed");

            shutdown_tx.send(()).expect("server running");
            server.await.expect("join").expect("serve");
        });
    }

    /// A connection that served requests and then went quiet is shut down
    /// gracefully once idle; one that keeps sending requests is not.
    #[test]
    fn idle_connections_are_shut_down() {
        block_on_traced(|handle| async move {
            let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
            let addr = listener.local_addr().expect("addr");
            let (shutdown_tx, shutdown_rx) = oneshot::channel::<()>();
            let server = tokio::spawn(serve_traced_with(
                listener,
                tower::service_fn(hello),
                handle,
                async move {
                    let _ = shutdown_rx.await;
                },
                short_limits(),
            ));

            let connect = || async {
                let stream = TcpStream::connect(addr).await.expect("connect");
                let (send, conn) = hyper::client::conn::http2::handshake(
                    hyper_util::rt::TokioExecutor::new(),
                    TokioIo::new(stream),
                )
                .await
                .expect("handshake");
                (send, tokio::spawn(conn))
            };
            let request = |send: &mut hyper::client::conn::http2::SendRequest<
                http_body_util::Full<bytes::Bytes>,
            >| {
                send.send_request(
                    hyper::Request::builder()
                        .uri("http://test/")
                        .body(http_body_util::Full::new(bytes::Bytes::new()))
                        .expect("request"),
                )
            };

            // Busy: a request every 200 ms for 1.5 s, well past the idle
            // limit in all, never past it between requests.
            let (mut busy, busy_conn) = connect().await;
            for _ in 0..8 {
                request(&mut busy).await.expect("busy request");
                tokio::time::sleep(Duration::from_millis(200)).await;
            }
            assert!(!busy_conn.is_finished(), "a busy connection was closed");

            // Idle: one request, then nothing.
            let (mut idle, idle_conn) = connect().await;
            request(&mut idle).await.expect("idle request");
            tokio::time::timeout(Duration::from_secs(5), idle_conn)
                .await
                .expect("the idle connection was not shut down")
                .expect("join")
                .expect("a clean GOAWAY, not an error");

            drop(busy);
            shutdown_tx.send(()).expect("server running");
            server.await.expect("join").expect("serve");
        });
    }

    /// At a connection cap, a newcomer gets in by the connection that has
    /// gone longest without a request being let go, gracefully; the others
    /// keep theirs.
    #[test]
    fn the_longest_idle_connection_makes_room_at_the_cap() {
        block_on_traced(|handle| async move {
            let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
            let addr = listener.local_addr().expect("addr");
            let limited = accept::Limited::new(listener, 2);
            let limits = ConnectionLimits {
                make_room: Some(limited.room_wanted()),
                ..ConnectionLimits::default()
            };
            let (shutdown_tx, shutdown_rx) = oneshot::channel::<()>();
            let server = tokio::spawn(serve_traced_with(
                limited,
                tower::service_fn(hello),
                handle,
                async move {
                    let _ = shutdown_rx.await;
                },
                limits,
            ));

            let connect = || async {
                let stream = TcpStream::connect(addr).await.expect("connect");
                let (send, conn) = hyper::client::conn::http2::handshake(
                    hyper_util::rt::TokioExecutor::new(),
                    TokioIo::new(stream),
                )
                .await
                .expect("handshake");
                (send, tokio::spawn(conn))
            };
            let request = |send: &mut hyper::client::conn::http2::SendRequest<
                http_body_util::Full<bytes::Bytes>,
            >| {
                send.send_request(
                    hyper::Request::builder()
                        .uri("http://test/")
                        .body(http_body_util::Full::new(bytes::Bytes::new()))
                        .expect("request"),
                )
            };

            let (mut stale, stale_conn) = connect().await;
            request(&mut stale).await.expect("stale request");
            tokio::time::sleep(Duration::from_millis(50)).await;
            let (mut recent, recent_conn) = connect().await;
            request(&mut recent).await.expect("recent request");

            let (mut newcomer, _newcomer_conn) = connect().await;
            tokio::time::timeout(Duration::from_secs(5), request(&mut newcomer))
                .await
                .expect("the newcomer was not let in")
                .expect("newcomer request");
            tokio::time::timeout(Duration::from_secs(5), stale_conn)
                .await
                .expect("the stale connection was not let go")
                .expect("join")
                .expect("a clean GOAWAY, not an error");
            assert!(
                !recent_conn.is_finished(),
                "the recent connection was let go"
            );
            request(&mut recent).await.expect("recent request, again");

            drop((stale, recent, newcomer));
            shutdown_tx.send(()).expect("server running");
            server.await.expect("join").expect("serve");
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
