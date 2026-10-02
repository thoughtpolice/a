// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: MIT OR Apache-2.0

//! The transport-neutral accept abstraction: a source of established
//! duplex byte streams, with no opinion about what is served over them.
//!
//! [`Accept`] is implemented here for [`TcpListener`]. Wrappers add
//! behavior over any source (e.g. `rustls-transport` for TLS
//! termination), and servers (e.g. `dial9-tonic`) drive one generically —
//! anything that can hand out `AsyncRead + AsyncWrite` streams (a
//! QUIC/iroh endpoint, an in-memory pipe, a Unix socket listener) plugs
//! into the same loop.

use std::future::Future;

use tokio::io::{AsyncRead, AsyncWrite};
use tokio::net::{TcpListener, TcpStream};

/// A source of accepted, ready-to-serve duplex byte streams.
///
/// Each yielded stream carries one connection. Transport-specific socket
/// setup belongs in the implementation, which also decides what is fatal:
/// an error from [`accept`](Accept::accept) stops the caller's accept
/// loop, so per-peer failures (say, one bad handshake) must be swallowed
/// rather than returned.
///
/// Returning `Ok(None)` means the source is exhausted (e.g. the endpoint
/// behind it closed): the caller should stop accepting, let live
/// connections finish, and wind down cleanly.
pub trait Accept {
    /// The duplex stream produced for each accepted connection.
    type Io: AsyncRead + AsyncWrite + Unpin + Send + 'static;

    /// Waits for the next connection.
    fn accept(&mut self) -> impl Future<Output = std::io::Result<Option<Self::Io>>> + Send;
}

impl Accept for TcpListener {
    type Io = TcpStream;

    async fn accept(&mut self) -> std::io::Result<Option<TcpStream>> {
        let (stream, _addr) = retry_accept(|| TcpListener::accept(self)).await?;
        // A failure here means the peer is already gone (reset between
        // accept and setsockopt); serving the doomed stream is harmless,
        // and per the Accept contract it must not stop the server.
        if let Err(_err) = stream.set_nodelay(true) {
            tracing::trace!("failed to set TCP_NODELAY: {_err}");
        }
        Ok(Some(stream))
    }
}

/// How often a newcomer held at the cap asks again for room.
pub const MAKE_ROOM_INTERVAL: std::time::Duration = std::time::Duration::from_secs(1);

/// At most `max` connections from `inner` open at once.
///
/// Every connection holds a descriptor, as does every file the server has
/// open; past the open-files limit, accepting fails and so does whatever
/// else needs a descriptor next, such as a store opening an SST.
///
/// At the cap, the next newcomer is accepted and held, and this asks, through
/// [`room_wanted`](Self::room_wanted), for an open connection to be let go
/// to make room for it, again every [`MAKE_ROOM_INTERVAL`] until a slot
/// frees; further newcomers wait in the listen backlog meanwhile. Only the
/// server knows which connections have gone quiet, so it chooses; without
/// one listening, the newcomer just waits for a connection to close.
pub struct Limited<A: Accept> {
    inner: A,
    slots: std::sync::Arc<tokio::sync::Semaphore>,
    max: usize,
    room_wanted: std::sync::Arc<tokio::sync::Notify>,
    /// A connection accepted at the cap, waiting for a slot. Kept in the
    /// struct (not the `accept` future) so a cancelled `accept` call (TLS
    /// termination races it against finished handshakes) loses no
    /// connection.
    waiting: Option<A::Io>,
}

impl<A: Accept> Limited<A> {
    pub fn new(inner: A, max: usize) -> Self {
        Self {
            inner,
            slots: std::sync::Arc::new(tokio::sync::Semaphore::new(max)),
            max,
            room_wanted: std::sync::Arc::default(),
            waiting: None,
        }
    }

    /// Notified each time a newcomer is waiting at the cap: something
    /// serving these connections should let one go.
    pub fn room_wanted(&self) -> std::sync::Arc<tokio::sync::Notify> {
        self.room_wanted.clone()
    }
}

impl<A: Accept + Send> Accept for Limited<A> {
    type Io = LimitedIo<A::Io>;

    async fn accept(&mut self) -> std::io::Result<Option<Self::Io>> {
        if self.waiting.is_none() {
            match self.inner.accept().await? {
                Some(io) => self.waiting = Some(io),
                None => return Ok(None),
            }
        }
        let slot = match self.slots.clone().try_acquire_owned() {
            Ok(slot) => slot,
            Err(_) => {
                tracing::warn!(
                    max = self.max,
                    "connection limit reached; asking for an idle connection to make room"
                );
                loop {
                    self.room_wanted.notify_one();
                    tokio::select! {
                        slot = self.slots.clone().acquire_owned() => {
                            break slot.expect("the semaphore is never closed");
                        }
                        _ = tokio::time::sleep(MAKE_ROOM_INTERVAL) => {}
                    }
                }
            }
        };
        let io = self.waiting.take().expect("accepted above");
        Ok(Some(LimitedIo { io, _slot: slot }))
    }
}

/// A connection counted against a [`Limited`] source's cap until dropped.
pub struct LimitedIo<T> {
    io: T,
    _slot: tokio::sync::OwnedSemaphorePermit,
}

impl<T: AsyncRead + Unpin> AsyncRead for LimitedIo<T> {
    fn poll_read(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
        buf: &mut tokio::io::ReadBuf<'_>,
    ) -> std::task::Poll<std::io::Result<()>> {
        std::pin::Pin::new(&mut self.io).poll_read(cx, buf)
    }
}

impl<T: AsyncWrite + Unpin> AsyncWrite for LimitedIo<T> {
    fn poll_write(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
        buf: &[u8],
    ) -> std::task::Poll<std::io::Result<usize>> {
        std::pin::Pin::new(&mut self.io).poll_write(cx, buf)
    }

    fn poll_write_vectored(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
        bufs: &[std::io::IoSlice<'_>],
    ) -> std::task::Poll<std::io::Result<usize>> {
        std::pin::Pin::new(&mut self.io).poll_write_vectored(cx, bufs)
    }

    fn is_write_vectored(&self) -> bool {
        self.io.is_write_vectored()
    }

    fn poll_flush(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<std::io::Result<()>> {
        std::pin::Pin::new(&mut self.io).poll_flush(cx)
    }

    fn poll_shutdown(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<std::io::Result<()>> {
        std::pin::Pin::new(&mut self.io).poll_shutdown(cx)
    }
}

/// How long to wait before accepting again after running out of file
/// descriptors or memory.
pub const ACCEPT_BACKOFF: std::time::Duration = std::time::Duration::from_millis(100);

/// What an `accept(2)` error says about the listener.
#[derive(Debug, PartialEq, Eq)]
enum AcceptError {
    /// One connection failed before it could be handed over (the peer
    /// reset or gave up, or the network under it went away); the next one
    /// may be fine.
    Connection,
    /// The process or system is out of file descriptors or memory. Pending
    /// connections wait in the listen backlog until something is freed.
    Exhausted,
    /// The listener itself is broken.
    Fatal,
}

fn classify(e: &std::io::Error) -> AcceptError {
    use std::io::ErrorKind;
    match e.kind() {
        ErrorKind::ConnectionAborted
        | ErrorKind::ConnectionReset
        | ErrorKind::ConnectionRefused
        | ErrorKind::HostUnreachable
        | ErrorKind::NetworkUnreachable
        | ErrorKind::NetworkDown
        | ErrorKind::TimedOut
        | ErrorKind::Interrupted
        | ErrorKind::WouldBlock => return AcceptError::Connection,
        ErrorKind::OutOfMemory => return AcceptError::Exhausted,
        _ => {}
    }
    match e.raw_os_error() {
        Some(libc::EMFILE | libc::ENFILE | libc::ENOBUFS | libc::ENOMEM) => AcceptError::Exhausted,
        // accept(2): Linux hands back errors already pending on the new
        // socket, which callers should treat like EAGAIN; a firewall rule
        // refusing the connection reports EPERM.
        Some(
            libc::EPROTO | libc::ENOPROTOOPT | libc::EHOSTDOWN | libc::EOPNOTSUPP | libc::EPERM,
        ) => AcceptError::Connection,
        #[cfg(target_os = "linux")]
        Some(libc::ENONET) => AcceptError::Connection,
        _ => AcceptError::Fatal,
    }
}

/// Call `accept` until it yields a connection or fails in a way that says
/// the listener is broken.
///
/// A server that let any accept error end its accept loop would go down
/// the first time a peer reset mid-handshake, or the moment a connection
/// flood used up its file descriptors, which is exactly when staying up
/// matters. Per-connection errors are skipped. Running out of descriptors
/// or memory waits [`ACCEPT_BACKOFF`] first, rather than spinning on an
/// error that only closing something will clear.
pub async fn retry_accept<T, F, Fut>(mut accept: F) -> std::io::Result<T>
where
    F: FnMut() -> Fut,
    Fut: Future<Output = std::io::Result<T>>,
{
    loop {
        match accept().await {
            Ok(conn) => return Ok(conn),
            Err(e) => match classify(&e) {
                AcceptError::Connection => tracing::trace!("accept: connection lost: {e}"),
                AcceptError::Exhausted => {
                    tracing::warn!(
                        "accept failed ({e}); retrying in {}ms",
                        ACCEPT_BACKOFF.as_millis()
                    );
                    tokio::time::sleep(ACCEPT_BACKOFF).await;
                }
                AcceptError::Fatal => return Err(e),
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};

    fn os(code: i32) -> std::io::Error {
        std::io::Error::from_raw_os_error(code)
    }

    #[test]
    fn errors_are_told_apart() {
        for code in [
            libc::ECONNABORTED,
            libc::ECONNRESET,
            libc::EPROTO,
            libc::EPERM,
        ] {
            assert_eq!(classify(&os(code)), AcceptError::Connection, "{code}");
        }
        for code in [libc::EMFILE, libc::ENFILE, libc::ENOBUFS, libc::ENOMEM] {
            assert_eq!(classify(&os(code)), AcceptError::Exhausted, "{code}");
        }
        for code in [libc::EBADF, libc::EINVAL, libc::ENOTSOCK] {
            assert_eq!(classify(&os(code)), AcceptError::Fatal, "{code}");
        }
    }

    /// Lost connections and exhaustion are ridden out, exhaustion after a
    /// pause; a broken listener is reported.
    #[tokio::test(start_paused = true)]
    async fn accept_rides_out_transient_errors() {
        let script = std::cell::RefCell::new(vec![
            Err(os(libc::ECONNABORTED)),
            Err(os(libc::EMFILE)),
            Err(os(libc::EMFILE)),
            Err(os(libc::ECONNRESET)),
            Ok(7),
        ]);
        let started = tokio::time::Instant::now();
        let got = retry_accept(|| {
            let next = script.borrow_mut().remove(0);
            async move { next }
        })
        .await
        .expect("a connection in the end");
        assert_eq!(got, 7);
        assert_eq!(started.elapsed(), ACCEPT_BACKOFF * 2);

        let err = retry_accept(|| async { Err::<(), _>(os(libc::EBADF)) })
            .await
            .unwrap_err();
        assert_eq!(err.raw_os_error(), Some(libc::EBADF));
    }

    /// Past the cap, accepting waits until a connection closes.
    #[tokio::test]
    async fn limited_waits_for_a_free_slot() {
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let addr = listener.local_addr().expect("local addr");
        let mut limited = Limited::new(listener, 2);
        let _clients: Vec<_> = connect_n(addr, 3).await;

        let first = Accept::accept(&mut limited)
            .await
            .expect("accept")
            .expect("a connection");
        let _second = Accept::accept(&mut limited)
            .await
            .expect("accept")
            .expect("a connection");
        let third = tokio::time::timeout(
            std::time::Duration::from_millis(200),
            Accept::accept(&mut limited),
        )
        .await;
        assert!(third.is_err(), "a third connection while two are open");

        drop(first);
        let third = tokio::time::timeout(
            std::time::Duration::from_secs(5),
            Accept::accept(&mut limited),
        )
        .await
        .expect("a slot freed")
        .expect("accept");
        assert!(third.is_some());
    }

    /// A newcomer at the cap asks for room, and keeps asking until it gets
    /// a slot; it is not lost when its `accept` call is cancelled.
    #[tokio::test(start_paused = true)]
    async fn a_newcomer_at_the_cap_asks_for_room() {
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let addr = listener.local_addr().expect("local addr");
        let mut limited = Limited::new(listener, 1);
        let room_wanted = limited.room_wanted();
        let mut clients = connect_n(addr, 2).await;

        let first = Accept::accept(&mut limited)
            .await
            .expect("accept")
            .expect("a connection");
        // Cancelled while it waits, after asking once.
        let waited =
            tokio::time::timeout(MAKE_ROOM_INTERVAL / 2, Accept::accept(&mut limited)).await;
        assert!(waited.is_err(), "a second connection while one is open");
        tokio::time::timeout(std::time::Duration::ZERO, room_wanted.notified())
            .await
            .expect("room was asked for");

        // Asked again while it still waits; then a slot frees.
        let second = tokio::spawn(async move {
            let io = Accept::accept(&mut limited).await.expect("accept");
            (io, limited)
        });
        room_wanted.notified().await;
        room_wanted.notified().await;
        drop(first);
        let (second, _limited) = second.await.expect("accept task");
        let mut second = second.expect("the held connection");
        clients[1].write_all(b"x").await.expect("write");
        let mut byte = [0u8; 1];
        second.read_exact(&mut byte).await.expect("read");
        assert_eq!(&byte, b"x", "the second client's own connection");
    }

    async fn connect_n(addr: std::net::SocketAddr, n: usize) -> Vec<TcpStream> {
        let mut out = Vec::new();
        for _ in 0..n {
            out.push(TcpStream::connect(addr).await.expect("connect"));
        }
        out
    }

    #[tokio::test]
    async fn tcp_listener_yields_nodelay_streams() {
        let mut listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let addr = listener.local_addr().expect("local addr");

        let client = tokio::spawn(async move {
            let mut stream = TcpStream::connect(addr).await.expect("connect");
            stream.write_all(b"ping").await.expect("write");
            let mut buf = [0u8; 4];
            stream.read_exact(&mut buf).await.expect("read");
            assert_eq!(&buf, b"pong");
        });

        let mut stream = Accept::accept(&mut listener)
            .await
            .expect("accept")
            .expect("a connection, not exhaustion");
        assert!(stream.nodelay().expect("query nodelay"));

        let mut buf = [0u8; 4];
        stream.read_exact(&mut buf).await.expect("read");
        assert_eq!(&buf, b"ping");
        stream.write_all(b"pong").await.expect("write");
        client.await.expect("client task");
    }
}
