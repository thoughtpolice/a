// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! Thin application adapters around `burrow-core`.

use std::future::Future;
use std::io;
use std::net::SocketAddr;
use std::pin::pin;
use std::time::Duration;

use anyhow::{Context, Result, anyhow};
use burrow_core::transport::{CLOSE_SHUTDOWN, DestinationPolicy, RESET_BUSY, Server, ServerConfig};
use burrow_core::{Client, LocalEof, Target};
use iroh::endpoint::{Connection, ConnectionError};
use iroh::{Endpoint, EndpointId};
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::oneshot;
use tokio::task::{JoinError, JoinSet};
use tracing::{debug, info, warn};

const MAX_LOCAL_CONNECTIONS: usize = 256;
const ACCEPT_BACKOFF: Duration = Duration::from_millis(100);
const PING_INTERVAL: Duration = Duration::from_millis(250);

/// Runs the reusable bounded server with the application's allowlist and
/// destination policy.
pub(crate) async fn serve<F, P>(
    endpoint: Endpoint,
    allow: impl IntoIterator<Item = EndpointId>,
    policy: P,
    shutdown: F,
) -> Result<()>
where
    F: Future,
    P: DestinationPolicy,
{
    serve_configured(endpoint, ServerConfig::new(allow), policy, shutdown).await
}

/// Runs the server with an application-specialized resource configuration.
pub(crate) async fn serve_configured<F, P>(
    endpoint: Endpoint,
    config: ServerConfig,
    policy: P,
    shutdown: F,
) -> Result<()>
where
    F: Future,
    P: DestinationPolicy,
{
    serve_configured_observed(endpoint, config, policy, shutdown)
        .await
        .map(|_| ())
}

/// Runs a configured server and reports the shutdown value only when that
/// future, rather than natural one-shot completion, stopped the server.
pub(crate) async fn serve_configured_observed<F, P>(
    endpoint: Endpoint,
    config: ServerConfig,
    policy: P,
    shutdown: F,
) -> Result<Option<F::Output>>
where
    F: Future,
    P: DestinationPolicy,
{
    let (observed, observation) = oneshot::channel();
    let shutdown = async move {
        let output = shutdown.await;
        let _ = observed.send(output);
    };
    let result = Server::new(endpoint, config, policy).serve(shutdown).await;
    // Server::serve drops its shutdown future before returning. The channel
    // therefore contains the selected shutdown value or is closed on natural
    // one-shot/endpoint completion; waiting here cannot outlive the server.
    let observation = observation.await.ok();
    result.map(|()| observation)
}

/// The SSH ProxyCommand mode: one acknowledged request spliced to stdio.
pub(crate) async fn connect_stdio<F>(
    client: Client,
    target: Target,
    shutdown: F,
) -> Result<Option<F::Output>>
where
    F: Future,
{
    connect_io(
        client,
        target,
        tokio::io::stdin(),
        tokio::io::stdout(),
        shutdown,
    )
    .await
}

/// Generic form of stdio forwarding, shared with pipeline regression tests so
/// they exercise the exact client control flow used by the CLI.
pub(crate) async fn connect_io<F, R, W>(
    client: Client,
    target: Target,
    local_read: R,
    local_write: W,
    shutdown: F,
) -> Result<Option<F::Output>>
where
    F: Future,
    R: AsyncRead + Unpin,
    W: AsyncWrite + Unpin,
{
    let mut shutdown = pin!(shutdown);
    let opened = tokio::select! {
        biased;
        signal = &mut shutdown => {
            client.shutdown().await;
            return Ok(Some(signal));
        }
        opened = client.open(target) => opened?,
    };
    let connection = opened.connection().clone();
    let tunnel = opened.splice(local_read, local_write, LocalEof::EndTunnel);
    let mut tunnel = pin!(tunnel);
    tokio::select! {
        biased;
        result = &mut tunnel => classify_stdio(&connection, result).map(|()| None),
        signal = &mut shutdown => {
            // Close the connection before dropping the splice future.  That
            // prevents SendStream::drop from turning interruption into FIN.
            connection.close(CLOSE_SHUTDOWN, b"client interrupted");
            client.shutdown().await;
            debug!("interrupted");
            Ok(Some(signal))
        }
    }
}

fn classify_stdio(connection: &Connection, result: Result<()>) -> Result<()> {
    let Err(err) = result else {
        return Ok(());
    };
    // Peer stream codes are more specific than the connection close that can
    // race them.  Check them before treating a code-zero close as ordinary.
    match peer_code(&err) {
        Some(burrow_core::splice::RESET_ABORTED) => {
            return Err(anyhow!(
                "the remote target aborted before the transfer finished"
            ));
        }
        Some(RESET_BUSY) => {
            return Err(anyhow!("the server's forwarding limit is full"));
        }
        _ => {}
    }
    if is_broken_pipe(&err) {
        debug!("the local process closed its pipe");
        return Ok(());
    }
    if matches!(
        connection.close_reason(),
        Some(ConnectionError::ApplicationClosed(ref close))
            if close.error_code == CLOSE_SHUTDOWN
    ) {
        return Err(anyhow!("the Burrow server shut down during the transfer"));
    }
    if is_normal_close(&err) {
        debug!("the server closed a finished connection: {err:#}");
        Ok(())
    } else {
        Err(err)
    }
}

/// Maps every accepted local TCP connection to one stream on the shared
/// Burrow client until the caller's single shutdown future resolves.
pub(crate) async fn connect_listen<F>(
    client: Client,
    target: Target,
    listen: SocketAddr,
    shutdown: F,
) -> Result<Option<F::Output>>
where
    F: Future,
{
    let listener = TcpListener::bind(listen)
        .await
        .with_context(|| format!("listening on {listen}"))?;
    let local = listener.local_addr()?;
    info!("listening on {local}");
    if local.ip().is_loopback() {
        warn!(
            "the local listener has no per-user authentication; other local users may be able to use it"
        );
    } else {
        warn!(
            "the local listener is remotely reachable and unauthenticated; anyone who reaches it can use the tunnel"
        );
    }

    let mut tasks = JoinSet::new();
    let mut shutdown = pin!(shutdown);
    let signal = 'accept: loop {
        if tasks.len() >= MAX_LOCAL_CONNECTIONS {
            tokio::select! {
                biased;
                signal = &mut shutdown => break 'accept signal,
                joined = tasks.join_next() => report_local_task(joined),
            }
            continue;
        }
        tokio::select! {
            biased;
            signal = &mut shutdown => break 'accept signal,
            accepted = listener.accept() => {
                let (tcp, peer) = match accepted {
                    Ok(accepted) => accepted,
                    Err(err) => {
                        warn!(%err, "accepting a local connection");
                        tokio::select! {
                            biased;
                            signal = &mut shutdown => break 'accept signal,
                            _ = tokio::time::sleep(ACCEPT_BACKOFF) => {}
                        }
                        continue;
                    }
                };
                debug!(%peer, %target, "local connection");
                let client = client.clone();
                let target = target.clone();
                tasks.spawn(async move { forward_local(tcp, client, target).await });
            }
            joined = tasks.join_next(), if !tasks.is_empty() => report_local_task(joined),
        }
    };

    // Make cancellation visible to the peer before aborting stream tasks.
    client.shutdown().await;
    tasks.abort_all();
    while let Some(joined) = tasks.join_next().await {
        report_local_task(Some(joined));
    }
    Ok(Some(signal))
}

async fn forward_local(tcp: TcpStream, client: Client, target: Target) -> Result<()> {
    let opened = client.open(target).await?;
    opened.splice_tcp(tcp).await
}

fn report_local_task(joined: Option<std::result::Result<Result<()>, JoinError>>) {
    let Some(result) = joined.and_then(task_output) else {
        return;
    };
    if let Err(err) = result {
        if peer_code(&err) == Some(burrow_core::splice::RESET_ABORTED) {
            debug!("the remote peer aborted a local stream: {err:#}");
        } else if is_normal_close(&err) {
            debug!("a local stream ended with its connection: {err:#}");
        } else {
            warn!("local forwarding failed: {err:#}");
        }
    }
}

/// Pings once, or until a selected direct path appears before `timeout`.
pub(crate) async fn ping(client: &Client, until_direct: bool, timeout: Duration) -> Result<()> {
    let deadline = tokio::time::Instant::now() + timeout;
    loop {
        let timeout_error = || {
            if until_direct {
                anyhow!("no direct path appeared within {timeout:?}")
            } else {
                anyhow!("ping timed out after {timeout:?}")
            }
        };
        let sample = tokio::time::timeout_at(deadline, client.ping())
            .await
            .map_err(|_| timeout_error())??;
        let selected = sample
            .connection()
            .paths()
            .iter()
            .find(|path| path.is_selected())
            .map(|path| {
                (
                    if path.is_relay() { "relay" } else { "direct" },
                    path.remote_addr().clone(),
                    path.rtt(),
                )
            });
        let is_direct = selected
            .as_ref()
            .is_some_and(|(kind, _, _)| *kind == "direct");
        match &selected {
            Some((kind, address, path_rtt)) => println!(
                "pong protocol={:?} path={kind} address={address} path_rtt={path_rtt:?}",
                sample.elapsed(),
            ),
            None => println!("pong protocol={:?} path=unknown", sample.elapsed()),
        }
        if !until_direct || is_direct {
            return Ok(());
        }
        tokio::time::timeout_at(deadline, tokio::time::sleep(PING_INTERVAL))
            .await
            .map_err(|_| anyhow!("no direct path appeared within {timeout:?}"))?;
    }
}

/// The two process-termination signals Burrow handles explicitly.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ShutdownSignal {
    Interrupt,
    Terminate,
}

impl ShutdownSignal {
    /// POSIX signal number, used when forwarding a signal to a child group.
    pub(crate) const fn number(self) -> i32 {
        match self {
            Self::Interrupt => 2,
            Self::Terminate => 15,
        }
    }

    pub(crate) const fn exit_code(self) -> i32 {
        128 + self.number()
    }
}

/// Registered SIGINT and SIGTERM receivers.
///
/// Construction installs both process handlers synchronously.  Keeping that
/// separate from [`ShutdownSignals::recv`] is important for child-command mode: no child
/// process group may exist before Burrow is ready to forward a terminating
/// signal to it.  SIGHUP deliberately keeps its inherited disposition, so
/// `nohup burrow serve &` remains alive.
pub(crate) struct ShutdownSignals {
    interrupt: tokio::signal::unix::Signal,
    terminate: tokio::signal::unix::Signal,
}

impl ShutdownSignals {
    pub(crate) fn new() -> io::Result<Self> {
        use tokio::signal::unix::{SignalKind, signal};

        // Register both before returning; `recv` performs no lazy setup.
        let interrupt = signal(SignalKind::interrupt())?;
        let terminate = signal(SignalKind::terminate())?;
        Ok(Self {
            interrupt,
            terminate,
        })
    }

    pub(crate) async fn recv(&mut self) -> ShutdownSignal {
        tokio::select! {
            received = self.interrupt.recv() => match received {
                Some(()) => ShutdownSignal::Interrupt,
                None => std::future::pending().await,
            },
            received = self.terminate.recv() => match received {
                Some(()) => ShutdownSignal::Terminate,
                None => std::future::pending().await,
            },
        }
    }
}

pub(crate) fn task_output<T>(result: std::result::Result<T, JoinError>) -> Option<T> {
    match result {
        Ok(output) => Some(output),
        Err(err) if err.is_panic() => std::panic::resume_unwind(err.into_panic()),
        Err(err) => {
            debug!(%err, "task was cancelled");
            None
        }
    }
}

fn peer_code(err: &anyhow::Error) -> Option<iroh::endpoint::VarInt> {
    err.downcast_ref::<io::Error>()
        .and_then(iroh_utils::peer_code)
}

fn is_normal_close(err: &anyhow::Error) -> bool {
    err.downcast_ref::<io::Error>()
        .is_some_and(iroh_utils::is_normal_close)
}

fn is_broken_pipe(err: &anyhow::Error) -> bool {
    err.downcast_ref::<io::Error>()
        .is_some_and(|err| err.kind() == io::ErrorKind::BrokenPipe)
}
