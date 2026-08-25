// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! A small SOCKS5 front end for a shared Burrow client.
//!
//! The caller owns listener policy, including binding only to loopback.  This
//! module only speaks unauthenticated SOCKS5, turns TCP CONNECT requests into
//! Burrow targets, and bounds the number of live connection tasks.

use std::collections::BTreeMap;
use std::io;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use burrow_core::{BurrowAddr, Client, Host, HostName, ResponseStatus, Target};
use iroh::Endpoint;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::oneshot;
use tokio::task::{JoinHandle, JoinSet};

const SOCKS_VERSION: u8 = 5;
const METHOD_NO_AUTH: u8 = 0;
const METHOD_NONE_ACCEPTABLE: u8 = 0xff;

const COMMAND_CONNECT: u8 = 1;
const COMMAND_BIND: u8 = 2;
const COMMAND_UDP_ASSOCIATE: u8 = 3;

const ADDRESS_IPV4: u8 = 1;
const ADDRESS_NAME: u8 = 3;
const ADDRESS_IPV6: u8 = 4;

const REPLY_OK: u8 = 0;
const REPLY_GENERAL_FAILURE: u8 = 1;
const REPLY_CONNECTION_NOT_ALLOWED: u8 = 2;
const REPLY_HOST_UNREACHABLE: u8 = 4;
const REPLY_COMMAND_NOT_SUPPORTED: u8 = 7;
const REPLY_ADDRESS_NOT_SUPPORTED: u8 = 8;

const SERVER_HOST: &str = "server.burrow";
const MAX_SOCKS_NAME_BYTES: usize = u8::MAX as usize;
const MAX_DYNAMIC_SERVERS: usize = 64;
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(15);
const ACCEPT_BACKOFF: Duration = Duration::from_millis(100);

#[derive(Clone, Debug, PartialEq, Eq)]
enum SocksRoute {
    /// Use the optional server supplied on the command line.
    Fixed(Target),
    /// Dial the self-contained address carried in the SOCKS hostname.
    Address { address: BurrowAddr, target: Target },
}

#[derive(Debug)]
enum SocksHost {
    Ip(IpAddr),
    Name(String),
}

struct ClientEntry {
    client: Client,
}

struct CachedClient {
    entry: Arc<ClientEntry>,
    last_used: u64,
}

struct EndpointDrain {
    stop: Option<oneshot::Sender<()>>,
    task: Option<JoinHandle<usize>>,
}

impl EndpointDrain {
    fn spawn(endpoint: Endpoint) -> Self {
        let (stop, stopped) = oneshot::channel();
        Self {
            stop: Some(stop),
            task: Some(tokio::spawn(drain_incoming(endpoint, stopped))),
        }
    }

    fn take(&mut self) -> (Option<oneshot::Sender<()>>, Option<JoinHandle<usize>>) {
        (self.stop.take(), self.task.take())
    }
}

impl Drop for EndpointDrain {
    fn drop(&mut self) {
        if let Some(stop) = self.stop.take() {
            let _ = stop.send(());
        }
        if let Some(task) = &self.task {
            task.abort();
        }
    }
}

struct RouterState {
    fixed: Option<Arc<ClientEntry>>,
    dynamic: BTreeMap<String, CachedClient>,
    next_use: u64,
    closed: bool,
}

struct RouterInner {
    endpoint: Endpoint,
    max_dynamic: usize,
    state: Mutex<RouterState>,
    drain: Mutex<EndpointDrain>,
}

/// Routes SOCKS requests through an optional fixed server or a bounded set of
/// clients named by self-contained `br1...` hostnames.
///
/// Every cached [`Client`] shares one iroh endpoint and identity.  The router
/// owns an endpoint-lifetime Incoming drain so a dynamic-only proxy is safe
/// while idle. Core's client-side drain is therefore redundant for each entry,
/// but remains safe and bounded by the 64-entry cache and handler admission,
/// plus one optional fixed client and this router task. Keeping the client
/// detail inside core is preferable to giving this application adapter a
/// subtly different connection lifecycle.
#[derive(Clone)]
pub(super) struct SocksRouter(Arc<RouterInner>);

impl SocksRouter {
    pub(super) fn new(endpoint: Endpoint, fixed: Option<Client>) -> Self {
        Self::with_limit(endpoint, fixed, MAX_DYNAMIC_SERVERS)
            .expect("the built-in dynamic-server limit is nonzero")
    }

    fn with_limit(
        endpoint: Endpoint,
        fixed: Option<Client>,
        max_dynamic: usize,
    ) -> io::Result<Self> {
        if max_dynamic == 0 {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "SOCKS dynamic-server limit must be nonzero",
            ));
        }
        let drain = EndpointDrain::spawn(endpoint.clone());
        Ok(Self(Arc::new(RouterInner {
            endpoint,
            max_dynamic,
            state: Mutex::new(RouterState {
                fixed: fixed.map(|client| Arc::new(ClientEntry { client })),
                dynamic: BTreeMap::new(),
                next_use: 0,
                closed: false,
            }),
            drain: Mutex::new(drain),
        })))
    }

    async fn resolve(&self, route: SocksRoute) -> io::Result<(Arc<ClientEntry>, Target)> {
        match route {
            SocksRoute::Fixed(target) => {
                let entry = self
                    .0
                    .state
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                if entry.closed {
                    return Err(router_closed());
                }
                entry
                    .fixed
                    .clone()
                    .map(|client| (client, target))
                    .ok_or_else(|| {
                        io::Error::new(
                            io::ErrorKind::PermissionDenied,
                            "this SOCKS request needs a fixed SERVER argument",
                        )
                    })
            }
            SocksRoute::Address { address, target } => {
                let key = address.as_str().to_owned();
                let (entry, evicted) = {
                    let mut state = self
                        .0
                        .state
                        .lock()
                        .unwrap_or_else(|poisoned| poisoned.into_inner());
                    if state.closed {
                        return Err(router_closed());
                    }
                    state.next_use = state.next_use.saturating_add(1);
                    let used = state.next_use;
                    if let Some(cached) = state.dynamic.get_mut(&key) {
                        cached.last_used = used;
                        return Ok((cached.entry.clone(), target));
                    }

                    let evicted = if state.dynamic.len() == self.0.max_dynamic {
                        let candidate = state
                            .dynamic
                            .iter()
                            .filter(|(_, cached)| Arc::strong_count(&cached.entry) == 1)
                            .min_by_key(|(_, cached)| cached.last_used)
                            .map(|(key, _)| key.clone())
                            .ok_or_else(|| {
                                io::Error::new(
                                    io::ErrorKind::WouldBlock,
                                    "the SOCKS dynamic-server cache is full of active clients",
                                )
                            })?;
                        state.dynamic.remove(&candidate).map(|cached| cached.entry)
                    } else {
                        None
                    };

                    let entry = Arc::new(ClientEntry {
                        client: Client::new(self.0.endpoint.clone(), address.endpoint_addr()),
                    });
                    state.dynamic.insert(
                        key,
                        CachedClient {
                            entry: entry.clone(),
                            last_used: used,
                        },
                    );
                    (entry, evicted)
                };

                // The evicted entry was cache-only while the mutex was held,
                // so this graceful close cannot interrupt a SOCKS handler.
                if let Some(evicted) = evicted {
                    evicted.client.close().await;
                }
                Ok((entry, target))
            }
        }
    }

    /// Closes every cached connection after the accept loop has joined all
    /// handlers.  `interrupted` preserves a nonzero transport outcome when
    /// handlers were cancelled or the owner was signalled.
    pub(super) async fn close_all(&self, interrupted: bool) -> usize {
        let entries = {
            let mut state = self
                .0
                .state
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            state.closed = true;
            let fixed = state.fixed.take();
            let dynamic = std::mem::take(&mut state.dynamic);
            fixed
                .into_iter()
                .chain(dynamic.into_values().map(|cached| cached.entry))
                .collect::<Vec<_>>()
        };
        for entry in entries {
            if interrupted {
                entry.client.shutdown().await;
            } else {
                entry.client.close().await;
            }
        }

        // Keep refusing unsolicited Initials until all cached Client drains
        // have stopped. This closes the only idle gap for a router with no
        // fixed client and no dynamic request yet.
        let (stop, task) = self
            .0
            .drain
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .take();
        if let Some(stop) = stop {
            let _ = stop.send(());
        }
        match task {
            Some(task) => match task.await {
                Ok(refused) => refused,
                Err(err) if err.is_panic() => std::panic::resume_unwind(err.into_panic()),
                Err(err) => {
                    tracing::warn!(error = %err, "SOCKS endpoint drain task was cancelled");
                    0
                }
            },
            None => 0,
        }
    }
}

fn router_closed() -> io::Error {
    io::Error::new(io::ErrorKind::BrokenPipe, "the SOCKS router is closed")
}

async fn drain_incoming(endpoint: Endpoint, mut stop: oneshot::Receiver<()>) -> usize {
    let mut refused = 0usize;
    loop {
        tokio::select! {
            biased;
            _ = &mut stop => return refused,
            incoming = endpoint.accept() => match incoming {
                Some(incoming) => {
                    refused = refused.saturating_add(1);
                    incoming.refuse();
                }
                None => return refused,
            },
        }
    }
}

/// A cooperatively stoppable SOCKS listener task.
///
/// Normal shutdown waits until every handler has been cancelled and joined.
/// Drop is only an early-error/panic fallback: it requests shutdown and aborts
/// the outer task so a dropped handle can never detach a live listener.
pub(super) struct SocksProxy {
    local_addr: SocketAddr,
    stop: Option<oneshot::Sender<()>>,
    task: Option<JoinHandle<io::Result<usize>>>,
}

impl SocksProxy {
    pub(super) fn local_addr(&self) -> SocketAddr {
        self.local_addr
    }

    /// Waits for an unexpected listener exit.  The returned count is the
    /// number of handler tasks that the accept loop had to cancel.
    pub(super) async fn wait(&mut self) -> io::Result<usize> {
        let result = self
            .task
            .as_mut()
            .expect("a SOCKS proxy task is awaited only once")
            .await;
        self.task = None;
        joined_proxy(result)
    }

    /// Stops accepting, aborts all handlers, and joins them before returning.
    pub(super) async fn shutdown(&mut self) -> io::Result<usize> {
        if let Some(stop) = self.stop.take() {
            let _ = stop.send(());
        }
        if self.task.is_some() {
            self.wait().await
        } else {
            Ok(0)
        }
    }
}

impl Drop for SocksProxy {
    fn drop(&mut self) {
        if let Some(stop) = self.stop.take() {
            let _ = stop.send(());
        }
        if let Some(task) = &self.task {
            task.abort();
        }
    }
}

fn joined_proxy(result: Result<io::Result<usize>, tokio::task::JoinError>) -> io::Result<usize> {
    match result {
        Ok(result) => result,
        Err(err) if err.is_panic() => std::panic::resume_unwind(err.into_panic()),
        Err(err) => Err(io::Error::other(format!("SOCKS task was cancelled: {err}"))),
    }
}

/// Starts the bounded accept loop in a task.  The returned owner reports the
/// listener's actual address, which is useful when the caller bound port zero.
pub(super) fn spawn_accept_loop(
    listener: TcpListener,
    router: SocksRouter,
    max_connections: usize,
) -> io::Result<SocksProxy> {
    validate_connection_limit(max_connections)?;
    let local_addr = listener.local_addr()?;
    let (stop, stopped) = oneshot::channel();
    let task = tokio::spawn(accept_loop(listener, router, max_connections, stopped));
    Ok(SocksProxy {
        local_addr,
        stop: Some(stop),
        task: Some(task),
    })
}

/// Accepts SOCKS connections while keeping at most `max_connections` handler
/// tasks alive.  Cooperative shutdown aborts and joins every handler before
/// returning the number which were still retained by the task set.
async fn accept_loop(
    listener: TcpListener,
    router: SocksRouter,
    max_connections: usize,
    mut stop: oneshot::Receiver<()>,
) -> io::Result<usize> {
    validate_connection_limit(max_connections)?;
    let mut tasks = JoinSet::new();

    'accept: loop {
        while tasks.len() >= max_connections {
            tokio::select! {
                biased;
                _ = &mut stop => break 'accept,
                joined = tasks.join_next() => report_join(joined, false),
            }
        }

        tokio::select! {
            biased;
            _ = &mut stop => break,
            accepted = listener.accept() => {
                let (stream, peer) = match accepted {
                    Ok(accepted) => accepted,
                    Err(err) => {
                        tracing::warn!(%err, "accepting a SOCKS connection");
                        tokio::select! {
                            biased;
                            _ = &mut stop => break 'accept,
                            _ = tokio::time::sleep(ACCEPT_BACKOFF) => {}
                        }
                        continue;
                    }
                };
                let router = router.clone();
                tasks.spawn(async move {
                    if let Err(err) = handle_connection(stream, router).await {
                        tracing::debug!(%peer, error = %err, "SOCKS connection ended");
                    }
                });
            }
            joined = tasks.join_next(), if !tasks.is_empty() => report_join(joined, false),
        }
    }

    drop(listener);
    Ok(abort_and_join(&mut tasks).await)
}

async fn abort_and_join(tasks: &mut JoinSet<()>) -> usize {
    tasks.abort_all();
    let mut cancelled = 0;
    while let Some(joined) = tasks.join_next().await {
        if matches!(&joined, Err(err) if err.is_cancelled()) {
            cancelled += 1;
        }
        report_join(Some(joined), true);
    }
    cancelled
}

fn validate_connection_limit(max_connections: usize) -> io::Result<()> {
    if max_connections == 0 {
        Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "SOCKS connection limit must be nonzero",
        ))
    } else {
        Ok(())
    }
}

fn report_join(joined: Option<Result<(), tokio::task::JoinError>>, shutting_down: bool) {
    if let Some(Err(err)) = joined {
        if err.is_cancelled() && shutting_down {
            tracing::trace!("cancelled a SOCKS handler during shutdown");
        } else {
            tracing::warn!(error = %err, "SOCKS handler task failed");
        }
    }
}

/// Serves one SOCKS5 connection through the fixed server or an address-host
/// client selected by the request.
pub(super) async fn handle_connection(
    mut socket: TcpStream,
    router: SocksRouter,
) -> io::Result<()> {
    if let Err(err) = socket.set_nodelay(true) {
        tracing::trace!(error = %err, "failed to set TCP_NODELAY on SOCKS connection");
    }

    let route = match tokio::time::timeout(HANDSHAKE_TIMEOUT, handshake(&mut socket)).await {
        Ok(result) => result?,
        Err(_) => {
            return Err(io::Error::new(
                io::ErrorKind::TimedOut,
                "SOCKS handshake timed out",
            ));
        }
    };
    let Some(route) = route else {
        return Ok(());
    };

    let (entry, target) = match router.resolve(route).await {
        Ok(resolved) => resolved,
        Err(err) => {
            let reply = if err.kind() == io::ErrorKind::PermissionDenied {
                REPLY_CONNECTION_NOT_ALLOWED
            } else {
                REPLY_GENERAL_FAILURE
            };
            write_reply(&mut socket, reply).await?;
            return Err(err);
        }
    };

    let opened = match entry.client.open(target).await {
        Ok(opened) => opened,
        Err(err) => {
            let reply = match err.response().map(|response| response.status) {
                Some(ResponseStatus::Denied) => REPLY_CONNECTION_NOT_ALLOWED,
                Some(ResponseStatus::Unreachable) => REPLY_HOST_UNREACHABLE,
                Some(ResponseStatus::Busy | ResponseStatus::BadRequest | ResponseStatus::Ok)
                | None => REPLY_GENERAL_FAILURE,
            };
            write_reply(&mut socket, reply).await?;
            return Err(io::Error::other(format!(
                "opening Burrow stream for SOCKS CONNECT: {err:#}"
            )));
        }
    };

    if let Err(err) = write_reply(&mut socket, REPLY_OK).await {
        // OpenedStream::drop explicitly resets and stops both QUIC halves.
        // Spell the drop out here because the SOCKS peer never received a
        // successful setup response and this must not look like a clean FIN.
        drop(opened);
        return Err(err);
    }
    let result = opened
        .splice_tcp(socket)
        .await
        .map_err(|err| io::Error::other(format!("proxying SOCKS connection: {err:#}")));
    // Keep the cache lease through the complete splice. An entry with a live
    // handler must never qualify for LRU eviction.
    drop(entry);
    result
}

async fn handshake<S>(socket: &mut S) -> io::Result<Option<SocksRoute>>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    if !select_no_auth(socket).await? {
        return Ok(None);
    }
    read_connect_request(socket).await
}

async fn select_no_auth<S>(socket: &mut S) -> io::Result<bool>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    let mut header = [0; 2];
    socket.read_exact(&mut header).await?;
    if header[0] != SOCKS_VERSION {
        return Err(invalid_data(format!(
            "unsupported SOCKS version {}",
            header[0]
        )));
    }

    let mut methods = [0; u8::MAX as usize];
    let method_count = header[1] as usize;
    socket.read_exact(&mut methods[..method_count]).await?;
    let selected = if methods[..method_count].contains(&METHOD_NO_AUTH) {
        METHOD_NO_AUTH
    } else {
        METHOD_NONE_ACCEPTABLE
    };
    socket.write_all(&[SOCKS_VERSION, selected]).await?;
    socket.flush().await?;
    Ok(selected == METHOD_NO_AUTH)
}

async fn read_connect_request<S>(socket: &mut S) -> io::Result<Option<SocksRoute>>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    let mut header = [0; 4];
    socket.read_exact(&mut header).await?;
    if header[0] != SOCKS_VERSION || header[2] != 0 {
        write_reply(socket, REPLY_GENERAL_FAILURE).await?;
        return Ok(None);
    }
    match header[1] {
        COMMAND_CONNECT => {}
        COMMAND_BIND | COMMAND_UDP_ASSOCIATE => {
            write_reply(socket, REPLY_COMMAND_NOT_SUPPORTED).await?;
            return Ok(None);
        }
        _ => {
            write_reply(socket, REPLY_COMMAND_NOT_SUPPORTED).await?;
            return Ok(None);
        }
    }

    let host = match read_host(socket, header[3]).await? {
        Some(host) => host,
        None => {
            write_reply(socket, REPLY_ADDRESS_NOT_SUPPORTED).await?;
            return Ok(None);
        }
    };
    let mut port = [0; 2];
    socket.read_exact(&mut port).await?;
    let port = u16::from_be_bytes(port);
    if port == 0 {
        write_reply(socket, REPLY_ADDRESS_NOT_SUPPORTED).await?;
        return Ok(None);
    }

    let route = match host {
        SocksHost::Ip(ip) => SocksRoute::Fixed(Target::Tcp {
            host: Host::Ip(ip),
            port,
        }),
        SocksHost::Name(name) if name.eq_ignore_ascii_case(SERVER_HOST) => {
            SocksRoute::Fixed(Target::LocalPort(port))
        }
        SocksHost::Name(name) if looks_like_burrow_address(&name) => {
            let address = match name.parse::<BurrowAddr>() {
                Ok(address) => address,
                Err(_) => {
                    // Address hostnames are case-sensitive opaque tokens. Do
                    // not turn a lowercased or corrupted token into an exit
                    // node DNS request to an unrelated name.
                    write_reply(socket, REPLY_ADDRESS_NOT_SUPPORTED).await?;
                    return Ok(None);
                }
            };
            SocksRoute::Address {
                address,
                target: Target::LocalPort(port),
            }
        }
        SocksHost::Name(name) => {
            let name = match HostName::from_string(name) {
                Ok(name) => name,
                Err(_) => {
                    write_reply(socket, REPLY_ADDRESS_NOT_SUPPORTED).await?;
                    return Ok(None);
                }
            };
            SocksRoute::Fixed(Target::Tcp {
                host: Host::Name(name),
                port,
            })
        }
    };
    Ok(Some(route))
}

fn looks_like_burrow_address(name: &str) -> bool {
    !name.contains('.')
        && name
            .get(..burrow_core::address::ADDRESS_PREFIX.len())
            .is_some_and(|prefix| prefix.eq_ignore_ascii_case(burrow_core::address::ADDRESS_PREFIX))
}

async fn read_host<S>(socket: &mut S, address_type: u8) -> io::Result<Option<SocksHost>>
where
    S: AsyncRead + Unpin,
{
    match address_type {
        ADDRESS_IPV4 => {
            let mut octets = [0; 4];
            socket.read_exact(&mut octets).await?;
            Ok(Some(SocksHost::Ip(IpAddr::V4(Ipv4Addr::from(octets)))))
        }
        ADDRESS_IPV6 => {
            let mut octets = [0; 16];
            socket.read_exact(&mut octets).await?;
            Ok(Some(SocksHost::Ip(IpAddr::V6(Ipv6Addr::from(octets)))))
        }
        ADDRESS_NAME => {
            let mut length = [0];
            socket.read_exact(&mut length).await?;
            let length = length[0] as usize;
            if length == 0 {
                return Ok(None);
            }
            let mut bytes = [0; MAX_SOCKS_NAME_BYTES];
            socket.read_exact(&mut bytes[..length]).await?;
            let name = match std::str::from_utf8(&bytes[..length]) {
                Ok(name) => name,
                Err(_) => return Ok(None),
            };
            Ok(Some(SocksHost::Name(name.to_owned())))
        }
        _ => Ok(None),
    }
}

async fn write_reply<S>(socket: &mut S, reply: u8) -> io::Result<()>
where
    S: AsyncWrite + Unpin,
{
    // Burrow cannot observe the server-side outbound socket's bound address,
    // so report the RFC-permitted unspecified address and port.
    socket
        .write_all(&[SOCKS_VERSION, reply, 0, ADDRESS_IPV4, 0, 0, 0, 0, 0, 0])
        .await?;
    socket.flush().await
}

fn invalid_data(message: impl Into<String>) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message.into())
}

#[cfg(test)]
#[path = "tests/socks.rs"]
mod tests;
