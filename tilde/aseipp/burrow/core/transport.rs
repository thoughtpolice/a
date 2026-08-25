// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! Bounded client/server lifecycle for the Burrow stream protocol.

use std::collections::{BTreeSet, HashMap};
use std::error::Error;
use std::fmt;
use std::future::Future;
use std::io::{self, IoSlice};
use std::pin::{Pin, pin};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex as StdMutex, Weak};
use std::task::{Context as TaskContext, Poll};
use std::time::{Duration, Instant};

use anyhow::Result;
use futures::FutureExt;
use futures::future::{BoxFuture, Shared};
use iroh::endpoint::{Connection, ConnectionError, RecvStream, SendStream, VarInt};
use iroh::{Endpoint, EndpointAddr, EndpointId};
use tokio::io::{AsyncRead, AsyncWrite, AsyncWriteExt, ReadBuf};
use tokio::net::TcpStream;
use tokio::sync::{Mutex, Semaphore, mpsc, watch};
use tokio::task::{JoinError, JoinHandle, JoinSet};
use tracing::{debug, info, warn};

use crate::protocol::{self, ALPN, ParseTargetError, Request, Response, ResponseStatus, Target};
use crate::splice::{LocalEof, RESET_ABORTED, splice_with_keepalive, splice_with_reporter};

/// An endpoint rejected by the application's post-handshake authorizer.
pub const CLOSE_NOT_ALLOWED: VarInt = VarInt::from_u32(1);
/// A fully authenticated connection refused because the server is full.
pub const CLOSE_BUSY: VarInt = VarInt::from_u32(5);
/// A connection interrupted because the serving process is shutting down.
pub const CLOSE_SHUTDOWN: VarInt = VarInt::from_u32(6);
/// Client-to-server close for a cached connection retired before a response.
pub const CLOSE_RETIRED: VarInt = VarInt::from_u32(7);
/// A stream refused because the global forwarding limit is full.
pub const RESET_BUSY: VarInt = VarInt::from_u32(4);

/// Client-side transport deadlines.
#[derive(Clone, Debug)]
pub struct ClientConfig {
    /// Maximum wall-clock time for endpoint lookup and a QUIC/TLS handshake.
    pub dial_timeout: Duration,
    /// Maximum wall-clock time to open a stream and receive its response.
    pub request_timeout: Duration,
}

impl Default for ClientConfig {
    fn default() -> Self {
        Self {
            dial_timeout: Duration::from_secs(15),
            request_timeout: Duration::from_secs(15),
        }
    }
}

/// A successfully opened byte stream.
#[derive(Debug)]
pub struct OpenedStream {
    /// The connection carrying the stream, retained for path/error inspection.
    connection: Connection,
    /// Bytes sent toward the selected target.
    send: Option<SendStream>,
    /// Bytes received from the selected target.
    recv: Option<RecvStream>,
    // A successful AsyncWrite shutdown commits a FIN. Resetting afterward can
    // discard bytes that the peer has not consumed yet.
    send_done: bool,
    // Once AsyncRead reports EOF, stopping the receive half is both needless
    // and capable of turning a clean stream into an abort at the peer.
    recv_done: bool,
    // Keep the managed connection alive even when the caller drops its last
    // separately-held Client while this stream is still in use.
    _client: Client,
    // Retain this particular connection after a safe retry installs a newer
    // current connection, so close_with can still find and close them both.
    _managed: Arc<ManagedConnection>,
}

/// Result of a protocol-level reachability probe.
#[derive(Debug)]
pub struct Ping {
    /// Time from opening the QUIC stream through receiving the response.
    elapsed: Duration,
    /// The connection used, for selected-path inspection.
    connection: Connection,
    // A Ping is itself a path-inspection handle. Keep its client and tracked
    // connection alive when it was produced from a temporary Client.
    _client: Client,
    _managed: Arc<ManagedConnection>,
}

impl OpenedStream {
    /// Returns the connection carrying this stream.
    pub fn connection(&self) -> &Connection {
        &self.connection
    }

    /// Splices this tunnel to arbitrary local read and write halves.
    ///
    /// The returned future owns all client and connection keepalives. Dropping
    /// it before or during polling resets and stops the QUIC stream before
    /// releasing those keepalives.
    pub fn splice<R, W>(
        mut self,
        local_read: R,
        local_write: W,
        local_eof: LocalEof,
    ) -> impl Future<Output = Result<()>>
    where
        R: AsyncRead + Unpin,
        W: AsyncWrite + Unpin,
    {
        let send = self
            .send
            .take()
            .expect("an opened stream owns its send half");
        let recv = self
            .recv
            .take()
            .expect("an opened stream owns its receive half");
        splice_with_keepalive(local_read, local_write, send, recv, local_eof, self)
    }

    /// Splices this tunnel to a TCP connection with half-close semantics.
    ///
    /// As with Self::splice, dropping the returned future before its first poll
    /// is cancellation-safe.
    pub fn splice_tcp(self, tcp: TcpStream) -> impl Future<Output = Result<()>> {
        let _ = tcp.set_nodelay(true);
        let (read, write) = tcp.into_split();
        self.splice(read, write, LocalEof::HalfClose)
    }

    fn send_mut(&mut self) -> &mut SendStream {
        self.send
            .as_mut()
            .expect("an opened stream retains its send half")
    }

    fn recv_mut(&mut self) -> &mut RecvStream {
        self.recv
            .as_mut()
            .expect("an opened stream retains its receive half")
    }
}

impl AsyncRead for OpenedStream {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut TaskContext<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        let had_capacity = buf.remaining() != 0;
        let filled = buf.filled().len();
        let result = AsyncRead::poll_read(Pin::new(self.recv_mut()), cx, buf);
        if had_capacity && matches!(&result, Poll::Ready(Ok(()))) && buf.filled().len() == filled {
            self.recv_done = true;
        }
        result
    }
}

impl AsyncWrite for OpenedStream {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut TaskContext<'_>,
        buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        AsyncWrite::poll_write(Pin::new(self.send_mut()), cx, buf)
    }

    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut TaskContext<'_>) -> Poll<io::Result<()>> {
        AsyncWrite::poll_flush(Pin::new(self.send_mut()), cx)
    }

    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut TaskContext<'_>) -> Poll<io::Result<()>> {
        let result = AsyncWrite::poll_shutdown(Pin::new(self.send_mut()), cx);
        if matches!(&result, Poll::Ready(Ok(()))) {
            self.send_done = true;
        }
        result
    }

    fn poll_write_vectored(
        mut self: Pin<&mut Self>,
        cx: &mut TaskContext<'_>,
        bufs: &[IoSlice<'_>],
    ) -> Poll<io::Result<usize>> {
        AsyncWrite::poll_write_vectored(Pin::new(self.send_mut()), cx, bufs)
    }

    fn is_write_vectored(&self) -> bool {
        self.send
            .as_ref()
            .expect("an opened stream retains its send half")
            .is_write_vectored()
    }
}

impl Drop for OpenedStream {
    fn drop(&mut self) {
        if !self.send_done {
            if let Some(send) = &mut self.send {
                let _ = send.reset(RESET_ABORTED);
            }
        }
        if !self.recv_done {
            if let Some(recv) = &mut self.recv {
                let _ = recv.stop(RESET_ABORTED);
            }
        }
    }
}

impl Ping {
    /// Returns the request/response round-trip time.
    pub fn elapsed(&self) -> Duration {
        self.elapsed
    }

    /// Returns the connection used by the probe for path inspection.
    pub fn connection(&self) -> &Connection {
        &self.connection
    }
}

/// Failure to dial a server or open a routed stream.
#[derive(Clone, Debug)]
pub enum ClientError {
    /// This client has already been closed.
    Closed,
    /// Establishing the shared QUIC connection exceeded the configured limit.
    DialTimeout(Duration),
    /// Establishing the shared QUIC connection failed.
    Dial(String),
    /// Stream setup or its response exceeded the configured limit.
    RequestTimeout(Duration),
    /// A programmatically constructed target violates the wire invariants.
    InvalidTarget(ParseTargetError),
    /// The connection or control protocol failed before a response arrived.
    Transport(String),
    /// The server returned a structured negative response.
    Rejected(Response),
}

impl ClientError {
    /// Returns the server's structured response, when it supplied one.
    pub fn response(&self) -> Option<&Response> {
        match self {
            Self::Rejected(response) => Some(response),
            _ => None,
        }
    }

    fn dial(error: impl fmt::Display) -> Self {
        Self::Dial(safe_diagnostic(error))
    }

    fn transport(message: impl AsRef<str>) -> Self {
        Self::Transport(protocol::sanitize_diagnostic(message.as_ref()))
    }
}

impl fmt::Display for ClientError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Closed => f.write_str("the Burrow client is closed"),
            Self::DialTimeout(timeout) => {
                write!(
                    f,
                    "connecting to the Burrow server timed out after {timeout:?}"
                )
            }
            Self::Dial(message) => write!(
                f,
                "connecting to the Burrow server: {}",
                protocol::sanitize_diagnostic(message)
            ),
            Self::RequestTimeout(timeout) => {
                write!(f, "the Burrow server did not answer within {timeout:?}")
            }
            Self::InvalidTarget(err) => write!(f, "invalid Burrow target: {err}"),
            Self::Transport(message) => f.write_str(&protocol::sanitize_diagnostic(message)),
            Self::Rejected(response) => {
                let summary = match response.status {
                    ResponseStatus::Ok => "unexpected successful response",
                    ResponseStatus::Denied => "the server denied the request",
                    ResponseStatus::Unreachable => "the server could not reach the target",
                    ResponseStatus::Busy => "the server is busy",
                    ResponseStatus::BadRequest => "the server rejected the request as invalid",
                };
                if response.message().is_empty() {
                    f.write_str(summary)
                } else {
                    write!(f, "{summary}: {}", response.message())
                }
            }
        }
    }
}

impl Error for ClientError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::InvalidTarget(err) => Some(err),
            _ => None,
        }
    }
}

fn safe_diagnostic(value: impl fmt::Display) -> String {
    protocol::sanitize_diagnostic(&value.to_string())
}

struct PreAckStreams {
    send: Option<SendStream>,
    recv: Option<RecvStream>,
}

impl PreAckStreams {
    fn new((send, recv): (SendStream, RecvStream)) -> Self {
        Self {
            send: Some(send),
            recv: Some(recv),
        }
    }

    fn parts_mut(&mut self) -> (&mut SendStream, &mut RecvStream) {
        (
            self.send
                .as_mut()
                .expect("the pre-ack guard owns its send half"),
            self.recv
                .as_mut()
                .expect("the pre-ack guard owns its receive half"),
        )
    }

    fn into_parts(mut self) -> (SendStream, RecvStream) {
        (
            self.send
                .take()
                .expect("the pre-ack guard owns its send half"),
            self.recv
                .take()
                .expect("the pre-ack guard owns its receive half"),
        )
    }

    fn finish_rejected(mut self) {
        if let Some(mut send) = self.send.take() {
            let _ = send.finish();
        }
        if let Some(mut recv) = self.recv.take() {
            let _ = recv.stop(iroh_utils::CLOSE_DONE);
        }
    }

    fn abort(&mut self) {
        if let Some(mut send) = self.send.take() {
            let _ = send.reset(RESET_ABORTED);
        }
        if let Some(mut recv) = self.recv.take() {
            let _ = recv.stop(RESET_ABORTED);
        }
    }
}

impl Drop for PreAckStreams {
    fn drop(&mut self) {
        self.abort();
    }
}

#[derive(Debug)]
struct UnclaimedConnection {
    connection: StdMutex<Option<Connection>>,
}

impl UnclaimedConnection {
    fn new(connection: Connection) -> Self {
        Self {
            connection: StdMutex::new(Some(connection)),
        }
    }

    fn claim(&self) -> Option<Connection> {
        self.connection
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .take()
    }

    fn close(&self, code: VarInt, reason: &[u8]) {
        if let Some(connection) = self.claim() {
            connection.close(code, reason);
        }
    }
}

impl Drop for UnclaimedConnection {
    fn drop(&mut self) {
        let connection = self
            .connection
            .get_mut()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(connection) = connection.take() {
            connection.close(CLOSE_RETIRED, b"completed dial was not adopted");
        }
    }
}

type DialResult = std::result::Result<Arc<UnclaimedConnection>, ClientError>;
type DialFuture = Shared<BoxFuture<'static, DialResult>>;

struct DialAttempt {
    generation: u64,
    future: DialFuture,
}

#[derive(Debug)]
struct ManagedConnection {
    connection: Connection,
    retired: AtomicBool,
}

impl ManagedConnection {
    fn new(connection: Connection) -> Self {
        Self {
            connection,
            retired: AtomicBool::new(false),
        }
    }

    fn retire(&self) {
        self.retired.store(true, Ordering::Release);
    }
}

impl Drop for ManagedConnection {
    fn drop(&mut self) {
        // Removing a failed connection from state must also release the peer's
        // server slot. Delay that close until older successful streams (which
        // hold their own Arc) are gone, so retirement never interrupts them.
        if self.retired.load(Ordering::Acquire) && self.connection.close_reason().is_none() {
            self.connection
                .close(CLOSE_RETIRED, b"retired after request failure");
        }
    }
}

#[derive(Default)]
struct ClientState {
    current: Option<Arc<ManagedConnection>>,
    dialing: Option<DialAttempt>,
    next_generation: u64,
    closed: Option<(VarInt, Vec<u8>)>,
}

struct ClientInner {
    endpoint: Endpoint,
    address: EndpointAddr,
    config: ClientConfig,
    state: Mutex<ClientState>,
    connections: StdMutex<HashMap<usize, Weak<ManagedConnection>>>,
    drain_stop: watch::Sender<bool>,
    drain_task: StdMutex<Option<JoinHandle<()>>>,
}

impl ClientInner {
    fn register(&self, connection: &Arc<ManagedConnection>) {
        let mut connections = self
            .connections
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        connections.retain(|_, connection| connection.strong_count() != 0);
        connections.insert(
            connection.connection.stable_id(),
            Arc::downgrade(connection),
        );
    }

    fn live_connections(&self) -> Vec<Arc<ManagedConnection>> {
        let mut live = Vec::new();
        let mut connections = self
            .connections
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        connections.retain(|_, connection| {
            if let Some(connection) = connection.upgrade() {
                live.push(connection);
                true
            } else {
                false
            }
        });
        live
    }
}

impl Drop for ClientInner {
    fn drop(&mut self) {
        let _ = self.drain_stop.send(true);
        if let Ok(task) = self.drain_task.get_mut() {
            if let Some(task) = task.take() {
                task.abort();
            }
        }
        // Keep the current Arc alive until after the weak registry is
        // collected. Other live Arcs belong to opened streams, Ping results,
        // or requests that were in flight when this final Client was dropped.
        let current = self
            .state
            .try_lock()
            .ok()
            .and_then(|mut state| state.current.take());
        let mut connections = self.live_connections();
        if let Some(current) = current {
            if !connections
                .iter()
                .any(|connection| Arc::ptr_eq(connection, &current))
            {
                connections.push(current);
            }
        }
        for connection in connections {
            connection
                .connection
                .close(CLOSE_SHUTDOWN, b"client dropped without a clean close");
        }
    }
}

/// A cloneable client that multiplexes requests over one shared connection.
///
/// Concurrent callers share a single in-flight dial.  A request which loses a
/// previously established connection before receiving its response invalidates
/// that connection, redials, and retries once.  No opaque application bytes
/// have been handed to the caller before that response, so this retry cannot
/// duplicate forwarded payload.
///
/// Dropping the final client or stream without calling Client::close
/// interrupts every still-managed connection with CLOSE_SHUTDOWN. A code-zero
/// connection close is reserved for the explicit graceful path.
#[derive(Clone)]
pub struct Client(Arc<ClientInner>);

impl fmt::Debug for Client {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Client")
            .field("remote", &self.0.address.id)
            .field("config", &self.0.config)
            .finish_non_exhaustive()
    }
}

impl Client {
    /// Creates a client with default deadlines.
    ///
    /// The endpoint must be client-only: this client continuously refuses
    /// unsolicited incoming QUIC Initials so iroh's pre-accept queue cannot be
    /// filled for the endpoint's lifetime.
    ///
    /// # Panics
    ///
    /// Panics when called outside an entered Tokio runtime, because the
    /// endpoint's incoming-drain task is spawned immediately.
    pub fn new(endpoint: Endpoint, address: EndpointAddr) -> Self {
        Self::with_config(endpoint, address, ClientConfig::default())
    }

    /// Creates a client with explicit deadlines.
    ///
    /// # Panics
    ///
    /// Panics when called outside an entered Tokio runtime, because the
    /// endpoint's incoming-drain task is spawned immediately.
    pub fn with_config(endpoint: Endpoint, address: EndpointAddr, config: ClientConfig) -> Self {
        let (drain_stop, drain_rx) = watch::channel(false);
        let drain_task = tokio::spawn(drain_incoming(endpoint.clone(), drain_rx));
        Self(Arc::new(ClientInner {
            endpoint,
            address,
            config,
            state: Mutex::new(ClientState::default()),
            connections: StdMutex::new(HashMap::new()),
            drain_stop,
            drain_task: StdMutex::new(Some(drain_task)),
        }))
    }

    /// Opens a routed byte stream and waits for the server's acknowledgement.
    pub async fn open(&self, target: Target) -> std::result::Result<OpenedStream, ClientError> {
        target.validate().map_err(ClientError::InvalidTarget)?;
        let (managed, send, recv) = self.request(Request::Connect(target)).await?;
        Ok(OpenedStream {
            connection: managed.connection.clone(),
            send: Some(send),
            recv: Some(recv),
            send_done: false,
            recv_done: false,
            _client: self.clone(),
            _managed: managed,
        })
    }

    /// Measures protocol-level reachability without opening a target socket.
    pub async fn ping(&self) -> std::result::Result<Ping, ClientError> {
        // Exclude initial endpoint lookup and QUIC/TLS setup from the reported
        // protocol RTT. A safe retry remains included when the first cached
        // connection fails before its response.
        let connection = self.connection().await?;
        let started = Instant::now();
        let (managed, mut send, mut recv) = self.request_from(Request::Ping, connection).await?;
        let _ = send.finish();
        let _ = recv.stop(iroh_utils::CLOSE_DONE);
        Ok(Ping {
            elapsed: started.elapsed(),
            connection: managed.connection.clone(),
            _client: self.clone(),
            _managed: managed,
        })
    }

    /// Cleanly closes every managed connection.
    ///
    /// The endpoint's incoming drain remains active until the final client or
    /// opened stream is dropped, so a retained endpoint cannot accumulate
    /// unsolicited Initials after this call.
    pub async fn close(&self) {
        self.close_with(iroh_utils::CLOSE_DONE, b"done").await;
    }

    /// Interrupts every managed connection with the explicit shutdown code.
    pub async fn shutdown(&self) {
        self.close_with(CLOSE_SHUTDOWN, b"client shutting down")
            .await;
    }

    /// Closes the managed connection with an application-defined reason.
    pub async fn close_with(&self, code: VarInt, reason: &[u8]) {
        let current = {
            let mut state = self.0.state.lock().await;
            if state.closed.is_none() {
                state.closed = Some((code, reason.to_vec()));
            }
            state.dialing = None;
            state.current.take()
        };
        // The weak registry includes retired connections that are retained by
        // older opened streams or Ping results. The local current Arc keeps
        // the newest connection upgradeable after removing it from state.
        let mut connections = self.0.live_connections();
        if let Some(current) = current {
            if !connections
                .iter()
                .any(|connection| Arc::ptr_eq(connection, &current))
            {
                connections.push(current);
            }
        }
        for connection in connections {
            connection.connection.close(code, reason);
        }
    }

    async fn request(
        &self,
        request: Request,
    ) -> std::result::Result<(Arc<ManagedConnection>, SendStream, RecvStream), ClientError> {
        let connection = self.connection().await?;
        self.request_from(request, connection).await
    }

    async fn request_from(
        &self,
        request: Request,
        mut connection: Arc<ManagedConnection>,
    ) -> std::result::Result<(Arc<ManagedConnection>, SendStream, RecvStream), ClientError> {
        for attempt in 0..2 {
            match self.request_once(&connection.connection, &request).await {
                Ok((send, recv)) => return Ok((connection, send, recv)),
                Err(failure) => {
                    if failure.retry {
                        // Never leave a connection that failed before its ACK
                        // installed as current, including the one produced by
                        // the single safe retry.
                        self.invalidate(&connection).await;
                        if attempt == 0 {
                            debug!(
                                "the shared connection failed before its response; redialing once"
                            );
                            connection = self.connection().await?;
                            continue;
                        }
                    }
                    return Err(failure.error);
                }
            }
        }
        unreachable!("the bounded retry loop always returns")
    }

    async fn request_once(
        &self,
        connection: &Connection,
        request: &Request,
    ) -> std::result::Result<(SendStream, RecvStream), AttemptFailure> {
        let timeout = self.0.config.request_timeout;
        let deadline = tokio::time::Instant::now() + timeout;
        let streams = match tokio::time::timeout_at(deadline, connection.open_bi()).await {
            Ok(Ok(streams)) => streams,
            Ok(Err(err)) => {
                return Err(self.connection_failure(connection, format!("opening a stream: {err}")));
            }
            Err(_) => {
                return Err(AttemptFailure::retry(ClientError::RequestTimeout(timeout)));
            }
        };
        // From the instant a stream ID is allocated until the peer's ACK is
        // decoded, cancellation must be visible as an abort rather than an
        // implicit clean finish from dropping the raw halves.
        let mut streams = PreAckStreams::new(streams);

        let exchange = async {
            let (send, recv) = streams.parts_mut();
            protocol::write_request(send, request).await?;
            protocol::read_response(recv).await
        };
        let response = match tokio::time::timeout_at(deadline, exchange).await {
            Ok(Ok(response)) => response,
            Ok(Err(err)) => {
                let peer_code = iroh_utils::peer_code(&err);
                streams.abort();
                if peer_code == Some(RESET_BUSY) {
                    return Err(AttemptFailure::final_error(ClientError::Rejected(
                        Response::new(ResponseStatus::Busy)
                            .with_message("the server forwarding limit is full"),
                    )));
                }
                return Err(self.connection_failure(
                    connection,
                    format!("exchanging a Burrow request: {err}"),
                ));
            }
            Err(_) => {
                streams.abort();
                return Err(AttemptFailure::retry(ClientError::RequestTimeout(timeout)));
            }
        };
        if !response.is_ok() {
            streams.finish_rejected();
            return Err(AttemptFailure::final_error(ClientError::Rejected(response)));
        }
        Ok(streams.into_parts())
    }

    fn connection_failure(&self, conn: &Connection, fallback: String) -> AttemptFailure {
        if let Some(error) = explain_connection(conn, self.0.endpoint.id()) {
            AttemptFailure::final_error(error)
        } else {
            // Until a successful response is decoded the caller has received
            // no stream and cannot have written application payload.  It is
            // therefore safe to invalidate even a connection that still
            // appears live (for example a blackholed cached path) and retry
            // the request once.
            AttemptFailure::retry(ClientError::transport(fallback))
        }
    }

    async fn connection(&self) -> std::result::Result<Arc<ManagedConnection>, ClientError> {
        loop {
            let (generation, dial) = {
                let mut state = self.0.state.lock().await;
                if state.closed.is_some() {
                    return Err(ClientError::Closed);
                }
                if state
                    .current
                    .as_ref()
                    .is_some_and(|connection| connection.connection.close_reason().is_some())
                {
                    state.current = None;
                }
                if let Some(connection) = &state.current {
                    return Ok(connection.clone());
                }
                if let Some(attempt) = &state.dialing {
                    (attempt.generation, attempt.future.clone())
                } else {
                    let endpoint = self.0.endpoint.clone();
                    let address = self.0.address.clone();
                    let timeout = self.0.config.dial_timeout;
                    let future = async move {
                        match tokio::time::timeout(timeout, endpoint.connect(address, ALPN)).await {
                            Ok(Ok(connection)) => {
                                Ok(Arc::new(UnclaimedConnection::new(connection)))
                            }
                            Ok(Err(err)) => Err(ClientError::dial(err)),
                            Err(_) => Err(ClientError::DialTimeout(timeout)),
                        }
                    }
                    .boxed()
                    .shared();
                    let generation = state.next_generation;
                    state.next_generation = state.next_generation.wrapping_add(1);
                    state.dialing = Some(DialAttempt {
                        generation,
                        future: future.clone(),
                    });
                    (generation, future)
                }
            };

            // A completed dial remains owned by UnclaimedConnection while this
            // waiter is queued on the state mutex. If this future is cancelled
            // and close_with concurrently removes the shared result from
            // state, the guard emits an explicit non-zero close.
            let result = dial.await;
            let mut state = self.0.state.lock().await;
            let owns_attempt = state
                .dialing
                .as_ref()
                .is_some_and(|attempt| attempt.generation == generation);
            if owns_attempt {
                state.dialing = None;
            }
            if let Some((code, reason)) = &state.closed {
                if let Ok(connection) = &result {
                    connection.close(*code, reason);
                }
                return Err(ClientError::Closed);
            }
            match result {
                Ok(unclaimed) => {
                    if let Some(current) = &state.current {
                        return Ok(current.clone());
                    }
                    if !owns_attempt {
                        // Another waiter adopted and subsequently retired this
                        // result. Never resurrect that stale connection.
                        drop(state);
                        continue;
                    }
                    let Some(connection) = unclaimed.claim() else {
                        // Claiming and installing are serialized by `state`, so
                        // this can only be a stale shared result. Start from the
                        // current state rather than returning an unmanaged QUIC
                        // handle.
                        drop(state);
                        continue;
                    };
                    let connection = Arc::new(ManagedConnection::new(connection));
                    self.0.register(&connection);
                    state.current = Some(connection.clone());
                    return Ok(connection);
                }
                Err(err) => return Err(err),
            }
        }
    }

    async fn invalidate(&self, failed: &Arc<ManagedConnection>) {
        failed.retire();
        let mut state = self.0.state.lock().await;
        if state
            .current
            .as_ref()
            .is_some_and(|current| Arc::ptr_eq(current, failed))
        {
            state.current = None;
        }
    }
}

struct AttemptFailure {
    error: ClientError,
    retry: bool,
}

impl AttemptFailure {
    fn retry(error: ClientError) -> Self {
        Self { error, retry: true }
    }

    fn final_error(error: ClientError) -> Self {
        Self {
            error,
            retry: false,
        }
    }
}

fn explain_connection(connection: &Connection, me: EndpointId) -> Option<ClientError> {
    let ConnectionError::ApplicationClosed(close) = connection.close_reason()? else {
        return None;
    };
    let response = if close.error_code == CLOSE_NOT_ALLOWED {
        Response::new(ResponseStatus::Denied).with_message(format!(
            "this endpoint is not allowed; permit client endpoint {me} on the server"
        ))
    } else if close.error_code == CLOSE_BUSY {
        Response::new(ResponseStatus::Busy).with_message("the server connection limit is full")
    } else if close.error_code == CLOSE_SHUTDOWN {
        Response::new(ResponseStatus::Busy).with_message("the server is shutting down")
    } else {
        // CLOSE_RETIRED is deliberately absent: only clients emit it when a
        // failed cached connection loses its last managed user. A server that
        // sends that code is treated as an ordinary transport failure.
        return None;
    };
    Some(ClientError::Rejected(response))
}

async fn drain_incoming(endpoint: Endpoint, mut stop: watch::Receiver<bool>) {
    loop {
        tokio::select! {
            biased;
            changed = stop.changed() => {
                if changed.is_err() || *stop.borrow() {
                    return;
                }
            }
            incoming = endpoint.accept() => match incoming {
                Some(incoming) => incoming.refuse(),
                None => return,
            },
        }
    }
}

// Server implementation follows below.  It lives in this module so admission,
// connection tracking, stream bounds, and close-code semantics cannot drift
// apart between protocol adapters.

/// Server-side admission, request, and forwarding limits.
#[derive(Clone, Debug)]
pub struct ServerConfig {
    /// Optional second authorization check after the authenticated handshake.
    /// `Some(empty)` denies everyone; `None` trusts authorization performed by
    /// endpoint hooks supplied by the application.
    pub allowed: Option<BTreeSet<EndpointId>>,
    /// Hard wall-clock limit for a TLS handshake, unaffected by packet activity.
    pub handshake_timeout: Duration,
    /// Limit for receiving a complete bounded request frame.
    pub request_timeout: Duration,
    /// Limit for policy evaluation and connecting the selected destination.
    pub target_timeout: Duration,
    /// Maximum simultaneous unauthenticated handshakes.
    pub max_pending_handshakes: usize,
    /// Maximum simultaneous authenticated connections.
    pub max_connections: usize,
    /// Maximum forwarding tasks on one connection.
    pub max_streams_per_connection: usize,
    /// Maximum forwarding tasks across the entire server.
    pub max_streams_total: usize,
    /// Stop after the first committed default destination stream finishes.
    ///
    /// While that stream is active the server continues consuming and
    /// refusing new Initials, and a requested shutdown still interrupts it.
    pub exit_after_first_stream: bool,
}

impl ServerConfig {
    /// Creates a securely-authorized configuration with default limits.
    pub fn new(allowed: impl IntoIterator<Item = EndpointId>) -> Self {
        Self {
            allowed: Some(allowed.into_iter().collect()),
            ..Self::default()
        }
    }
}

impl Default for ServerConfig {
    fn default() -> Self {
        Self {
            allowed: Some(BTreeSet::new()),
            handshake_timeout: Duration::from_secs(10),
            request_timeout: Duration::from_secs(10),
            target_timeout: Duration::from_secs(10),
            max_pending_handshakes: 32,
            max_connections: 64,
            max_streams_per_connection: 64,
            max_streams_total: 256,
            exit_after_first_stream: false,
        }
    }
}

type BoxedDestinationRead = Box<dyn AsyncRead + Unpin + Send + 'static>;
type BoxedDestinationWrite = Box<dyn AsyncWrite + Unpin + Send + 'static>;
type DestinationRollback = Box<dyn FnOnce(Destination) + Send + 'static>;

/// An authorized byte-stream destination served through a Burrow tunnel.
pub struct Destination {
    read: Option<BoxedDestinationRead>,
    write: Option<BoxedDestinationWrite>,
    local_eof: LocalEof,
    rollback: Option<DestinationRollback>,
}

impl Destination {
    /// Wraps a TCP socket with normal half-close semantics.
    pub fn tcp(stream: TcpStream) -> Self {
        let _ = stream.set_nodelay(true);
        let (read, write) = stream.into_split();
        Self::split(read, write, LocalEof::HalfClose)
    }

    /// Wraps arbitrary owned read and write halves.
    ///
    /// Bytes from `read` flow to the Burrow client and bytes from the client
    /// flow to `write`. Use [`LocalEof::EndTunnel`] when `write` cannot express
    /// a half-close, such as process stdout.
    pub fn split<R, W>(read: R, write: W, local_eof: LocalEof) -> Self
    where
        R: AsyncRead + Unpin + Send + 'static,
        W: AsyncWrite + Unpin + Send + 'static,
    {
        Self {
            read: Some(Box::new(read)),
            write: Some(Box::new(write)),
            local_eof,
            rollback: None,
        }
    }

    /// Creates a one-way destination which receives the entire client stream.
    ///
    /// EOF is sent back to the client only after the client has sent EOF and
    /// `write` has shut down successfully. This is Tailcat-style sink behavior:
    /// early server input EOF can never look like delivery confirmation.
    pub fn sink<W>(write: W) -> Self
    where
        W: AsyncWrite + Unpin + Send + 'static,
    {
        let (finished, eof) = tokio::sync::oneshot::channel();
        Self::split(
            SinkEof::new(eof),
            SinkWrite::new(write, finished),
            LocalEof::HalfClose,
        )
    }

    /// Restores this destination through `rollback` if it is dropped before
    /// the server successfully writes its positive response.
    ///
    /// Policies can use this to lend a unique resource transactionally. The
    /// callback is disarmed synchronously when forwarding is committed.
    pub fn reclaim_on_abort<F>(mut self, rollback: F) -> Self
    where
        F: FnOnce(Destination) + Send + 'static,
    {
        assert!(
            self.rollback.is_none(),
            "a Destination can have only one reclaim callback"
        );
        self.rollback = Some(Box::new(rollback));
        self
    }

    /// Returns the destination's local EOF behavior.
    pub fn local_eof(&self) -> LocalEof {
        self.local_eof
    }

    fn take_parts(&mut self) -> (BoxedDestinationRead, BoxedDestinationWrite, LocalEof) {
        (
            self.read.take().expect("a Destination owns its read half"),
            self.write
                .take()
                .expect("a Destination owns its write half"),
            self.local_eof,
        )
    }

    /// Commits this destination and constructs its cancellation-safe splice
    /// future synchronously. This is deliberately not async: after a positive
    /// response is written, there must be no cancellation point before the
    /// stream abort guard owns both QUIC halves.
    fn forward(
        mut self,
        send: SendStream,
        recv: RecvStream,
        completion: Option<OneShotCompletion>,
    ) -> impl Future<Output = Result<()>> {
        // A successful response commits a transactionally lent destination.
        self.rollback = None;
        let (read, write, local_eof) = self.take_parts();
        let wait_for_stop = completion.as_ref().map(|_| Duration::from_secs(5));
        splice_with_reporter(
            read,
            write,
            send,
            recv,
            local_eof,
            completion,
            wait_for_stop,
            |completion, result| {
                if let Some(completion) = completion.as_mut() {
                    completion.complete(result);
                }
            },
        )
    }
}

impl Drop for Destination {
    fn drop(&mut self) {
        let Some(rollback) = self.rollback.take() else {
            return;
        };
        let (read, write, local_eof) = self.take_parts();
        rollback(Self {
            read: Some(read),
            write: Some(write),
            local_eof,
            rollback: None,
        });
    }
}

enum SinkEofState {
    Waiting(tokio::sync::oneshot::Receiver<()>),
    Eof,
    Failed,
}

struct SinkEof {
    state: SinkEofState,
}

impl SinkEof {
    fn new(finished: tokio::sync::oneshot::Receiver<()>) -> Self {
        Self {
            state: SinkEofState::Waiting(finished),
        }
    }
}

impl AsyncRead for SinkEof {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut TaskContext<'_>,
        _buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        match &mut self.state {
            SinkEofState::Waiting(finished) => match Pin::new(finished).poll(cx) {
                Poll::Pending => Poll::Pending,
                Poll::Ready(Ok(())) => {
                    self.state = SinkEofState::Eof;
                    Poll::Ready(Ok(()))
                }
                Poll::Ready(Err(_)) => {
                    self.state = SinkEofState::Failed;
                    Poll::Ready(Err(sink_closed_early()))
                }
            },
            SinkEofState::Eof => Poll::Ready(Ok(())),
            SinkEofState::Failed => Poll::Ready(Err(sink_closed_early())),
        }
    }
}

fn sink_closed_early() -> io::Error {
    io::Error::new(
        io::ErrorKind::BrokenPipe,
        "destination sink closed before successful shutdown",
    )
}

struct SinkWrite<W> {
    inner: W,
    finished: Option<tokio::sync::oneshot::Sender<()>>,
}

impl<W> SinkWrite<W> {
    fn new(inner: W, finished: tokio::sync::oneshot::Sender<()>) -> Self {
        Self {
            inner,
            finished: Some(finished),
        }
    }
}

impl<W> AsyncWrite for SinkWrite<W>
where
    W: AsyncWrite + Unpin,
{
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut TaskContext<'_>,
        buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        Pin::new(&mut self.inner).poll_write(cx, buf)
    }

    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut TaskContext<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.inner).poll_flush(cx)
    }

    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut TaskContext<'_>) -> Poll<io::Result<()>> {
        match Pin::new(&mut self.inner).poll_shutdown(cx) {
            Poll::Ready(Ok(())) => {
                if let Some(finished) = self.finished.take() {
                    if finished.send(()).is_err() {
                        return Poll::Ready(Err(sink_closed_early()));
                    }
                }
                Poll::Ready(Ok(()))
            }
            result => result,
        }
    }

    fn poll_write_vectored(
        mut self: Pin<&mut Self>,
        cx: &mut TaskContext<'_>,
        bufs: &[IoSlice<'_>],
    ) -> Poll<io::Result<usize>> {
        Pin::new(&mut self.inner).poll_write_vectored(cx, bufs)
    }

    fn is_write_vectored(&self) -> bool {
        self.inner.is_write_vectored()
    }
}

impl From<TcpStream> for Destination {
    fn from(stream: TcpStream) -> Self {
        Self::tcp(stream)
    }
}

/// Boxed destination-policy operation used by [`Server`].
pub type PolicyFuture = BoxFuture<'static, std::result::Result<Destination, Response>>;

/// Authorizes a requested target and, when allowed, connects it.
///
/// The policy receives an authenticated endpoint ID.  It owns DNS behavior and
/// must apply its policy to resolved addresses as well as names, preventing a
/// name-resolution policy bypass.  Core supplies an outer timeout.
pub trait DestinationPolicy: Send + Sync + 'static {
    /// Authorizes and connects one request.
    fn connect(&self, remote: EndpointId, target: Target) -> PolicyFuture;
}

impl<F, Fut> DestinationPolicy for F
where
    F: Fn(EndpointId, Target) -> Fut + Send + Sync + 'static,
    Fut: Future<Output = std::result::Result<Destination, Response>> + Send + 'static,
{
    fn connect(&self, remote: EndpointId, target: Target) -> PolicyFuture {
        Box::pin((self)(remote, target))
    }
}

/// A bounded server for an already-configured iroh endpoint.
pub struct Server<P> {
    endpoint: Endpoint,
    config: ServerConfig,
    policy: Arc<P>,
}

enum OneShotEvent {
    Committed {
        owner: usize,
    },
    Finished {
        owner: usize,
        outcome: std::result::Result<(), String>,
    },
}

/// Serializes provisional one-shot claims across every authenticated
/// connection. A reservation is intentionally held across policy evaluation
/// and the positive response write; dropping it before commit reopens the
/// server for a later request.
struct OneShotCoordinator {
    reservation: Arc<Semaphore>,
    committed: AtomicBool,
    events: mpsc::UnboundedSender<OneShotEvent>,
}

impl OneShotCoordinator {
    fn new(events: mpsc::UnboundedSender<OneShotEvent>) -> Self {
        Self {
            reservation: Arc::new(Semaphore::new(1)),
            committed: AtomicBool::new(false),
            events,
        }
    }

    async fn reserve(self: &Arc<Self>) -> Option<OneShotReservation> {
        let permit = self
            .reservation
            .clone()
            .acquire_owned()
            .await
            .expect("the one-shot reservation semaphore is never closed");
        if self.committed.load(Ordering::Acquire) {
            return None;
        }
        Some(OneShotReservation {
            coordinator: self.clone(),
            _permit: permit,
        })
    }
}

struct OneShotReservation {
    coordinator: Arc<OneShotCoordinator>,
    _permit: tokio::sync::OwnedSemaphorePermit,
}

impl OneShotReservation {
    fn commit(self, owner: usize) -> OneShotCompletion {
        let was_committed = self.coordinator.committed.swap(true, Ordering::AcqRel);
        debug_assert!(!was_committed, "one-shot reservations are serialized");
        let coordinator = self.coordinator.clone();
        let _ = coordinator.events.send(OneShotEvent::Committed { owner });
        drop(self);
        OneShotCompletion {
            coordinator,
            owner,
            reported: false,
        }
    }
}

/// Reports the winning one-shot splice result. Its Drop path represents
/// cancellation and is ordered after the splice resource guard has reset both
/// QUIC halves.
struct OneShotCompletion {
    coordinator: Arc<OneShotCoordinator>,
    owner: usize,
    reported: bool,
}

impl OneShotCompletion {
    fn complete(&mut self, result: &Result<()>) {
        if self.reported {
            return;
        }
        self.reported = true;
        let outcome = result
            .as_ref()
            .map(|_| ())
            .map_err(|err| safe_diagnostic(format_args!("{err:#}")));
        let _ = self.coordinator.events.send(OneShotEvent::Finished {
            owner: self.owner,
            outcome,
        });
    }
}

impl Drop for OneShotCompletion {
    fn drop(&mut self) {
        if self.reported {
            return;
        }
        self.reported = true;
        let _ = self.coordinator.events.send(OneShotEvent::Finished {
            owner: self.owner,
            outcome: Err("the committed one-shot forwarding task was cancelled".to_owned()),
        });
    }
}

enum ServeExit {
    Shutdown,
    EndpointClosed,
    OneShot(std::result::Result<(), String>),
}

/// Owns a completed handshake until it has synchronously entered admission.
///
/// JoinSet drops task outputs when its parent future is cancelled. Keeping
/// the close in this output's Drop implementation prevents that cancellation
/// path from turning a successfully authenticated connection into QUIC's
/// misleading application close code zero.
struct CompletedHandshake(Option<Connection>);

impl CompletedHandshake {
    fn new(connection: Connection) -> Self {
        Self(Some(connection))
    }

    fn into_connection(mut self) -> Connection {
        self.0
            .take()
            .expect("a completed handshake owns one connection")
    }

    fn close(mut self, code: VarInt, reason: &'static [u8]) {
        if let Some(connection) = self.0.take() {
            connection.close(code, reason);
        }
    }
}

impl Drop for CompletedHandshake {
    fn drop(&mut self) {
        if let Some(connection) = self.0.take() {
            connection.close(CLOSE_SHUTDOWN, b"server task dropped");
        }
    }
}

/// Retains and shutdown-closes every admitted connection.
///
/// This local is deliberately declared after the connection JoinSet in
/// Server::serve. Rust drops locals in reverse declaration order, so this
/// guard sends the nonzero close before dropping the tasks' Connection clones.
#[derive(Default)]
struct ActiveConnections(HashMap<usize, Connection>);

impl ActiveConnections {
    fn insert(&mut self, id: usize, connection: Connection) {
        self.0.insert(id, connection);
    }

    fn remove(&mut self, id: &usize) {
        self.0.remove(id);
    }

    fn close_except(&self, keep: usize, code: VarInt, reason: &'static [u8]) {
        for (id, connection) in &self.0 {
            if *id != keep {
                connection.close(code, reason);
            }
        }
    }

    fn close_and_clear(&mut self, code: VarInt, reason: &'static [u8]) {
        for connection in self.0.values() {
            connection.close(code, reason);
        }
        self.0.clear();
    }
}

impl Drop for ActiveConnections {
    fn drop(&mut self) {
        self.close_and_clear(CLOSE_SHUTDOWN, b"server task dropped");
    }
}

impl<P> fmt::Debug for Server<P> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Server")
            .field("endpoint", &self.endpoint.id())
            .field("config", &self.config)
            .finish_non_exhaustive()
    }
}

impl<P> Server<P>
where
    P: DestinationPolicy,
{
    /// Creates a server.  The endpoint must advertise [`ALPN`].
    pub fn new(endpoint: Endpoint, config: ServerConfig, policy: P) -> Self {
        Self {
            endpoint,
            config,
            policy: Arc::new(policy),
        }
    }

    /// Serves until `shutdown` resolves or the endpoint closes.
    ///
    /// On requested shutdown every tracked authenticated connection is first
    /// closed with [`CLOSE_SHUTDOWN`].  The caller may then call
    /// [`Endpoint::close`] to flush those nonzero close frames and tear down the
    /// shared endpoint.
    pub async fn serve<F>(self, shutdown: F) -> Result<()>
    where
        F: Future<Output = ()>,
    {
        let handshake_slots = Arc::new(Semaphore::new(self.config.max_pending_handshakes));
        let connection_slots = Arc::new(Semaphore::new(self.config.max_connections));
        let stream_slots = Arc::new(Semaphore::new(self.config.max_streams_total));
        let (one_shot_events, mut one_shot_event_rx) = mpsc::unbounded_channel();
        let one_shot = self
            .config
            .exit_after_first_stream
            .then(|| Arc::new(OneShotCoordinator::new(one_shot_events)));
        let mut handshakes = JoinSet::new();
        let mut connections = JoinSet::new();
        // Keep this after connections: it must close retained connections
        // before cancellation drops the task-owned Connection clones.
        let mut active = ActiveConnections::default();
        let mut shutdown = pin!(shutdown);
        let mut one_shot_owner = None;
        let exit = loop {
            tokio::select! {
                biased;
                _ = &mut shutdown => break ServeExit::Shutdown,
                event = one_shot_event_rx.recv(), if one_shot.is_some() => {
                    match event.expect("Server retains the one-shot event sender") {
                        OneShotEvent::Committed { owner } => {
                            debug_assert!(one_shot_owner.is_none());
                            one_shot_owner = Some(owner);
                            // No later handshake can claim the unique stream.
                            // Closing already-admitted losers also prevents an
                            // idle pre-claim connection from lingering through
                            // the winning transfer.
                            handshakes.abort_all();
                            active.close_except(
                                owner,
                                CLOSE_BUSY,
                                b"one-shot stream already committed",
                            );
                        }
                        OneShotEvent::Finished { owner, outcome } => {
                            debug_assert_eq!(one_shot_owner, Some(owner));
                            break ServeExit::OneShot(outcome);
                        }
                    }
                }
                result = handshakes.join_next(), if !handshakes.is_empty() => {
                    if let Some(connection) = joined_handshake(result) {
                        if one_shot_owner.is_some() {
                            connection.close(CLOSE_BUSY, b"one-shot stream already committed");
                        } else {
                            admit_connection(
                                connection.into_connection(),
                                &self.config,
                                &self.policy,
                                &connection_slots,
                                &stream_slots,
                                one_shot.clone(),
                                &mut active,
                                &mut connections,
                            );
                        }
                    }
                }
                result = connections.join_next(), if !connections.is_empty() => {
                    if let Some(id) = joined_connection(result) {
                        active.remove(&id);
                    }
                }
                incoming = self.endpoint.accept() => {
                    let Some(incoming) = incoming else {
                        break ServeExit::EndpointClosed;
                    };
                    if one_shot_owner.is_some() {
                        // Keep consuming iroh's bounded pre-accept queue for
                        // the full lifetime of a long-running one-shot tunnel.
                        if !incoming.remote_addr_validated() {
                            if let Err(err) = incoming.retry() {
                                err.into_incoming().refuse();
                            }
                        } else {
                            incoming.refuse();
                        }
                        continue;
                    }
                    // Retry consumes this Incoming immediately.  For direct
                    // paths it validates the source address; over a relay it
                    // imposes a full extra RTT before expensive TLS work.
                    if !incoming.remote_addr_validated() {
                        if let Err(err) = incoming.retry() {
                            err.into_incoming().refuse();
                        }
                        continue;
                    }
                    let Ok(permit) = handshake_slots.clone().try_acquire_owned() else {
                        incoming.refuse();
                        debug!("refused a connection because the handshake limit is full");
                        continue;
                    };
                    let timeout = self.config.handshake_timeout;
                    handshakes.spawn(async move {
                        let _permit = permit;
                        match tokio::time::timeout(timeout, async move { incoming.await }).await {
                            Ok(Ok(connection)) => Some(CompletedHandshake::new(connection)),
                            Ok(Err(err)) => {
                                let error = safe_diagnostic(err);
                                debug!(%error, "incoming handshake failed");
                                None
                            }
                            Err(_) => {
                                debug!("incoming handshake timed out after {timeout:?}");
                                None
                            }
                        }
                    });
                }
            }
        };

        // A completed handshake can be sitting in JoinSet's output when the
        // shutdown branch wins.  Abort does not remove completed output, so
        // inspect every result and explicitly close successful races.
        handshakes.abort_all();
        let (handshake_code, handshake_reason): (VarInt, &'static [u8]) = match &exit {
            ServeExit::OneShot(_) => (CLOSE_BUSY, b"one-shot stream finished"),
            ServeExit::Shutdown | ServeExit::EndpointClosed => {
                (CLOSE_SHUTDOWN, b"server shutting down")
            }
        };
        while let Some(result) = handshakes.join_next().await {
            if let Some(connection) = joined_handshake(Some(result)) {
                connection.close(handshake_code, handshake_reason);
            }
        }

        match &exit {
            ServeExit::Shutdown | ServeExit::EndpointClosed => {
                active.close_and_clear(CLOSE_SHUTDOWN, b"server shutting down");
            }
            ServeExit::OneShot(Ok(())) => {
                active.close_and_clear(iroh_utils::CLOSE_DONE, b"one-shot stream complete");
            }
            ServeExit::OneShot(Err(_)) => {
                active.close_and_clear(CLOSE_SHUTDOWN, b"one-shot stream failed");
            }
        }
        while let Some(result) = connections.join_next().await {
            if let Some(id) = joined_connection(Some(result)) {
                active.remove(&id);
            }
        }
        match exit {
            ServeExit::OneShot(Err(error)) => {
                Err(anyhow::anyhow!("one-shot forwarding failed: {error}"))
            }
            ServeExit::Shutdown | ServeExit::EndpointClosed | ServeExit::OneShot(Ok(())) => Ok(()),
        }
    }
}

/// Convenience form of [`Server::serve`].
pub async fn serve<P, F>(
    endpoint: Endpoint,
    config: ServerConfig,
    policy: P,
    shutdown: F,
) -> Result<()>
where
    P: DestinationPolicy,
    F: Future<Output = ()>,
{
    Server::new(endpoint, config, policy).serve(shutdown).await
}

fn admit_connection<P>(
    connection: Connection,
    config: &ServerConfig,
    policy: &Arc<P>,
    connection_slots: &Arc<Semaphore>,
    stream_slots: &Arc<Semaphore>,
    one_shot: Option<Arc<OneShotCoordinator>>,
    active: &mut ActiveConnections,
    tasks: &mut JoinSet<(usize, EndpointId, ConnectionError)>,
) where
    P: DestinationPolicy,
{
    let remote = connection.remote_id();
    if config
        .allowed
        .as_ref()
        .is_some_and(|allowed| !allowed.contains(&remote))
    {
        // A reachable listener can receive this indefinitely from arbitrary
        // authenticated endpoint IDs; keep refusal amplification out of WARN.
        debug!(%remote, "refused an endpoint that is not on the server allowlist");
        connection.close(CLOSE_NOT_ALLOWED, b"not allowed");
        return;
    }
    let Ok(permit) = connection_slots.clone().try_acquire_owned() else {
        connection.close(CLOSE_BUSY, b"connection limit full");
        debug!(%remote, "refused an authenticated connection because the limit is full");
        return;
    };
    let id = connection.stable_id();
    active.insert(id, connection.clone());
    let policy = policy.clone();
    let stream_slots = stream_slots.clone();
    let request_timeout = config.request_timeout;
    let target_timeout = config.target_timeout;
    let per_connection = config.max_streams_per_connection;
    info!(remote = %remote.fmt_short(), "connected");
    tasks.spawn(async move {
        let _permit = permit;
        let reason = forward_streams(
            &connection,
            remote,
            policy,
            stream_slots,
            per_connection,
            request_timeout,
            target_timeout,
            one_shot,
        )
        .await;
        (id, remote, reason)
    });
}

async fn forward_streams<P>(
    connection: &Connection,
    remote: EndpointId,
    policy: Arc<P>,
    global_slots: Arc<Semaphore>,
    per_connection: usize,
    request_timeout: Duration,
    target_timeout: Duration,
    one_shot: Option<Arc<OneShotCoordinator>>,
) -> ConnectionError
where
    P: DestinationPolicy,
{
    let mut streams = JoinSet::new();
    let reason = loop {
        if per_connection > 0 && streams.len() >= per_connection {
            tokio::select! {
                reason = connection.closed() => break reason,
                result = streams.join_next() => {
                    if let Some(result) = result {
                        report_stream(result);
                    }
                }
            }
            continue;
        }
        tokio::select! {
            accepted = connection.accept_bi() => {
                let (mut send, mut recv) = match accepted {
                    Ok(streams) => streams,
                    Err(err) => break err,
                };
                if per_connection == 0 {
                    let _ = send.reset(RESET_BUSY);
                    let _ = recv.stop(RESET_BUSY);
                    debug!(%remote, "refused a stream because the per-connection limit is zero");
                    continue;
                }
                let permit = match global_slots.clone().try_acquire_owned() {
                    Ok(permit) => permit,
                    Err(_) => {
                        let _ = send.reset(RESET_BUSY);
                        let _ = recv.stop(RESET_BUSY);
                        debug!(%remote, "refused a stream because the global limit is full");
                        continue;
                    }
                };
                let policy = policy.clone();
                let one_shot = one_shot.clone();
                // Arm before spawning. If this task is cancelled before its
                // first poll, Drop still resets/stops both raw QUIC halves.
                let guarded_streams = PreAckStreams::new((send, recv));
                let owner = connection.stable_id();
                streams.spawn(async move {
                    let _permit = permit;
                    handle_stream(
                        owner,
                        remote,
                        policy,
                        guarded_streams,
                        request_timeout,
                        target_timeout,
                        one_shot,
                    )
                    .await
                });
            }
            accepted = connection.accept_uni() => {
                match accepted {
                    Ok(mut recv) => {
                        let _ = recv.stop(RESET_ABORTED);
                        debug!(%remote, "stopped an unsupported unidirectional stream");
                    }
                    Err(err) => break err,
                }
            }
            result = streams.join_next(), if !streams.is_empty() => {
                if let Some(result) = result {
                    report_stream(result);
                }
            }
        }
    };

    // Once the connection is gone, a target connect future cannot produce a
    // useful stream.  Abort it immediately instead of delaying shutdown until
    // TARGET_TIMEOUT.
    streams.abort_all();
    while let Some(result) = streams.join_next().await {
        report_stream(result);
    }
    reason
}

async fn handle_stream<P>(
    owner: usize,
    remote: EndpointId,
    policy: Arc<P>,
    mut streams: PreAckStreams,
    request_timeout: Duration,
    target_timeout: Duration,
    one_shot: Option<Arc<OneShotCoordinator>>,
) -> Result<()>
where
    P: DestinationPolicy,
{
    let request = match {
        let (_, recv) = streams.parts_mut();
        tokio::time::timeout(request_timeout, protocol::read_request(recv)).await
    } {
        Ok(Ok(request)) => request,
        Ok(Err(err)) => {
            let response = Response::new(ResponseStatus::BadRequest).with_message(err.to_string());
            write_terminal_response(&mut streams, &response).await?;
            streams.finish_rejected();
            return Ok(());
        }
        Err(_) => {
            let response = Response::new(ResponseStatus::BadRequest)
                .with_message(format!("request timed out after {request_timeout:?}"));
            write_terminal_response(&mut streams, &response).await?;
            streams.finish_rejected();
            return Ok(());
        }
    };

    match request {
        Request::Ping => {
            write_terminal_response(&mut streams, &Response::ok()).await?;
            streams.finish_rejected();
            Ok(())
        }
        Request::Connect(target) => {
            if one_shot.is_some() && target != Target::Default {
                let response = Response::new(ResponseStatus::Denied)
                    .with_message("one-shot servers accept only the default destination");
                write_terminal_response(&mut streams, &response).await?;
                streams.finish_rejected();
                return Ok(());
            }

            let reservation = if let Some(coordinator) = one_shot.as_ref() {
                match coordinator.reserve().await {
                    Some(reservation) => Some(reservation),
                    None => {
                        let response = Response::new(ResponseStatus::Busy)
                            .with_message("the one-shot destination is already committed");
                        write_terminal_response(&mut streams, &response).await?;
                        streams.finish_rejected();
                        return Ok(());
                    }
                }
            } else {
                None
            };

            let policy_result = {
                let connect = tokio::time::timeout(target_timeout, policy.connect(remote, target));
                let (send, _) = streams.parts_mut();
                tokio::select! {
                    biased;
                    stopped = send.stopped() => {
                        match stopped {
                            Ok(Some(code)) => debug!(
                                %remote,
                                %code,
                                "peer cancelled a request before acknowledgement"
                            ),
                            Ok(None) => debug!(
                                %remote,
                                "peer closed a request before acknowledgement"
                            ),
                            Err(err) => {
                                let error = safe_diagnostic(err);
                                debug!(%remote, %error, "peer disappeared before acknowledgement");
                            }
                        }
                        // This is a pre-commit caller cancellation, not a
                        // server forwarding failure. Returning normally keeps
                        // it out of WARN while PreAckStreams::drop still sends
                        // the explicit reset/stop pair and releases any
                        // one-shot reservation.
                        return Ok(());
                    }
                    result = connect => result,
                }
            };
            let destination = match policy_result {
                Ok(Ok(destination)) => destination,
                Ok(Err(mut response)) => {
                    if response.is_ok() {
                        response = Response::new(ResponseStatus::BadRequest).with_message(
                            "destination policy returned success without a destination",
                        );
                    }
                    write_terminal_response(&mut streams, &response).await?;
                    streams.finish_rejected();
                    return Ok(());
                }
                Err(_) => {
                    let response = Response::new(ResponseStatus::Unreachable).with_message(
                        format!("target connection timed out after {target_timeout:?}"),
                    );
                    write_terminal_response(&mut streams, &response).await?;
                    streams.finish_rejected();
                    return Ok(());
                }
            };
            {
                let (send, _) = streams.parts_mut();
                protocol::write_response(send, &Response::ok()).await?;
            }
            let completion = reservation.map(|reservation| reservation.commit(owner));
            let (send, recv) = streams.into_parts();
            destination.forward(send, recv, completion).await
        }
    }
}

async fn write_terminal_response(streams: &mut PreAckStreams, response: &Response) -> Result<()> {
    let (send, _) = streams.parts_mut();
    protocol::write_response(send, response).await?;
    send.shutdown().await?;
    Ok(())
}

fn joined_handshake(
    result: Option<std::result::Result<Option<CompletedHandshake>, JoinError>>,
) -> Option<CompletedHandshake> {
    match result? {
        Ok(connection) => connection,
        Err(err) if err.is_panic() => std::panic::resume_unwind(err.into_panic()),
        Err(_) => None,
    }
}

fn joined_connection(
    result: Option<std::result::Result<(usize, EndpointId, ConnectionError), JoinError>>,
) -> Option<usize> {
    match result? {
        Ok((id, remote, reason)) => {
            let reason = safe_diagnostic(reason);
            info!(remote = %remote.fmt_short(), %reason, "disconnected");
            Some(id)
        }
        Err(err) if err.is_panic() => std::panic::resume_unwind(err.into_panic()),
        Err(_) => None,
    }
}

fn report_stream(result: std::result::Result<Result<()>, JoinError>) {
    match result {
        Ok(Ok(())) => {}
        Ok(Err(err)) => {
            let peer_code = err
                .downcast_ref::<std::io::Error>()
                .and_then(iroh_utils::peer_code);
            let error = safe_diagnostic(format_args!("{err:#}"));
            if peer_code == Some(RESET_ABORTED) {
                debug!(%error, "peer aborted a forwarding stream");
            } else if err
                .downcast_ref::<std::io::Error>()
                .is_some_and(iroh_utils::is_normal_close)
            {
                debug!(%error, "stream ended with its connection");
            } else {
                warn!(%error, "forwarding stream failed");
            }
        }
        Err(err) if err.is_panic() => std::panic::resume_unwind(err.into_panic()),
        Err(_) => {}
    }
}

#[cfg(test)]
#[path = "../tests/core/transport.rs"]
mod tests;
