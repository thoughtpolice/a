// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! Cross-module and end-to-end Burrow tests.

use std::collections::BTreeSet;
use std::future;
use std::io;
use std::net::SocketAddr;
use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;
use std::pin::Pin;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::task::{Context, Poll};
use std::time::Duration;

use burrow_core::protocol::ALPN;
use burrow_core::transport::{CLOSE_SHUTDOWN, DestinationPolicy, ServerConfig};
use burrow_core::{Client, Host, HostName, LocalEof, OpenedStream, ResponseStatus, Target};
use iroh::endpoint::ConnectionError;
use iroh::{Endpoint, RelayMode, SecretKey};
use tokio::io::{AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::net::{TcpListener, TcpSocket};
use tokio::sync::{Notify, oneshot};

use super::config::{default_key_path_from, load_or_create_key, log_filter_from};
use super::endpoint::{CLOSE_NOT_ALLOWED, Role, bind};
use super::policy::{PipePolicy, PortSet, RoutePolicy};
use super::tunnel::{ShutdownSignal, connect_io, serve_configured, serve_configured_observed};

/// Long enough that a slow machine will not trip it, short enough that a
/// deadlock fails the test instead of hanging the suite.
const PATIENCE: Duration = Duration::from_secs(10);

/// Reserves an ephemeral TCP port without listening on it. Connections to
/// the address are refused, and holding the socket removes the usual race in
/// which another process claims a port between discovery and use.
fn closed_tcp_target() -> (TcpSocket, SocketAddr) {
    let socket = TcpSocket::new_v4().expect("creating an unavailable target socket");
    socket
        .bind("127.0.0.1:0".parse().expect("loopback address"))
        .expect("reserving an unavailable target port");
    let addr = socket.local_addr().expect("unavailable target address");
    (socket, addr)
}

/// Serves TCP echo on loopback and returns its address.
async fn tcp_echo_server() -> SocketAddr {
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .expect("binding echo");
    let addr = listener.local_addr().expect("echo address");
    tokio::spawn(async move {
        while let Ok((mut stream, _)) = listener.accept().await {
            tokio::spawn(async move {
                let (mut read, mut write) = stream.split();
                let _ = tokio::io::copy(&mut read, &mut write).await;
            });
        }
    });
    addr
}

/// Sends one line and closes only its write half, while continuing to drain
/// input. This models a target that is done producing output but is still
/// willing to receive bytes already in flight.
async fn tcp_greeter() -> SocketAddr {
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .expect("binding greeter");
    let addr = listener.local_addr().expect("greeter address");
    tokio::spawn(async move {
        while let Ok((mut stream, _)) = listener.accept().await {
            tokio::spawn(async move {
                let _ = stream.write_all(b"hello\n").await;
                let _ = stream.shutdown().await;
                let mut discarded = Vec::new();
                let _ = stream.read_to_end(&mut discarded).await;
            });
        }
    });
    addr
}

/// Closes its write half, then keeps reading. The receiver proves bytes sent
/// after the client observed that EOF still reached the target.
async fn tcp_half_closer() -> (SocketAddr, oneshot::Receiver<Vec<u8>>) {
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .expect("binding half-closer");
    let addr = listener.local_addr().expect("half-closer address");
    let (sent, received) = oneshot::channel();
    tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.expect("accepting at half-closer");
        stream
            .write_all(b"finished writing\n")
            .await
            .expect("writing before half-close");
        stream.shutdown().await.expect("half-closing target output");
        let mut input = Vec::new();
        stream
            .read_to_end(&mut input)
            .await
            .expect("reading after half-close");
        sent.send(input).expect("the test still wants target input");
    });
    (addr, received)
}

/// A complete loopback-only client/server deployment. The one-shot is the
/// same kind of single shutdown future used by the binary.
struct TestRig {
    server_endpoint: Endpoint,
    client_endpoint: Endpoint,
    client: Client,
    stop: Option<oneshot::Sender<()>>,
    server_task: Option<tokio::task::JoinHandle<anyhow::Result<()>>>,
}

struct DropNotice(Arc<Notify>);

impl Drop for DropNotice {
    fn drop(&mut self) {
        self.0.notify_one();
    }
}

impl TestRig {
    async fn start<P>(policy: P, allow_client: bool) -> Self
    where
        P: DestinationPolicy,
    {
        Self::start_configured(policy, allow_client, |_| {}).await
    }

    async fn start_configured<P, F>(policy: P, allow_client: bool, configure: F) -> Self
    where
        P: DestinationPolicy,
        F: FnOnce(&mut ServerConfig),
    {
        let client_endpoint = bind(SecretKey::generate(), RelayMode::Disabled, Role::Client)
            .await
            .expect("binding the client");
        let allowed: BTreeSet<_> = allow_client
            .then(|| client_endpoint.id())
            .into_iter()
            .collect();
        let server_endpoint = bind(
            SecretKey::generate(),
            RelayMode::Disabled,
            Role::Server(allowed.clone()),
        )
        .await
        .expect("binding the server");
        let client = Client::new(
            client_endpoint.clone(),
            iroh_utils::dialable_addr(&server_endpoint),
        );
        let (stop, stopped) = oneshot::channel();
        let serving_endpoint = server_endpoint.clone();
        let mut config = ServerConfig::new(allowed.clone());
        configure(&mut config);
        let server_task = tokio::spawn(async move {
            serve_configured(serving_endpoint, config, policy, async move {
                let _ = stopped.await;
            })
            .await
        });
        Self {
            server_endpoint,
            client_endpoint,
            client,
            stop: Some(stop),
            server_task: Some(server_task),
        }
    }

    fn trigger_shutdown(&mut self) {
        if let Some(stop) = self.stop.take() {
            let _ = stop.send(());
        }
    }

    async fn server_result(&mut self) -> anyhow::Result<()> {
        let Some(task) = self.server_task.take() else {
            return Ok(());
        };
        tokio::time::timeout(PATIENCE, task)
            .await
            .expect("the server did not stop after shutdown")
            .expect("the server task panicked")
    }

    async fn wait_for_server(&mut self) {
        self.server_result().await.expect("the server failed");
    }

    async fn finish(mut self) {
        self.trigger_shutdown();
        self.wait_for_server().await;
        self.client.close().await;
        tokio::time::timeout(PATIENCE, self.client_endpoint.close())
            .await
            .expect("the client endpoint would not close");
        tokio::time::timeout(PATIENCE, self.server_endpoint.close())
            .await
            .expect("the server endpoint would not close");
    }
}

async fn observed_pipe_outcome(
    signal: Option<ShutdownSignal>,
) -> (Option<ShutdownSignal>, Vec<u8>) {
    let client_endpoint = bind(SecretKey::generate(), RelayMode::Disabled, Role::Client)
        .await
        .expect("binding the observed-pipe client");
    let allowed: BTreeSet<_> = [client_endpoint.id()].into_iter().collect();
    let server_endpoint = bind(
        SecretKey::generate(),
        RelayMode::Disabled,
        Role::Server(allowed.clone()),
    )
    .await
    .expect("binding the observed-pipe server");
    let client = Client::new(
        client_endpoint.clone(),
        iroh_utils::dialable_addr(&server_endpoint),
    );
    let (server_stdout, mut server_stdout_reader) = tokio::io::duplex(64);
    let mut config = ServerConfig::new(allowed);
    config.exit_after_first_stream = true;
    config.max_streams_per_connection = 1;
    let (stop, stopped) = oneshot::channel();
    let serving_endpoint = server_endpoint.clone();
    let server_task = tokio::spawn(async move {
        serve_configured_observed(
            serving_endpoint,
            config,
            PipePolicy::sink(server_stdout),
            async move { stopped.await.expect("the test retains the shutdown sender") },
        )
        .await
    });

    let mut opened = client
        .open(Target::Default)
        .await
        .expect("claiming the observed one-shot pipe");
    let mut stop = Some(stop);
    if let Some(signal) = signal {
        stop.take()
            .expect("the shutdown sender is available")
            .send(signal)
            .expect("the observed server still wants its signal");
    } else {
        opened
            .write_all(b"natural pipe completion")
            .await
            .expect("writing the natural pipe payload");
        opened.shutdown().await.expect("finishing the pipe input");
        let mut response = Vec::new();
        opened
            .read_to_end(&mut response)
            .await
            .expect("draining the one-way response");
        assert!(response.is_empty());
    }

    let outcome = tokio::time::timeout(PATIENCE, server_task)
        .await
        .expect("the observed pipe server did not stop")
        .expect("the observed pipe server panicked")
        .expect("the observed pipe server failed");
    drop(stop);
    drop(opened);
    let mut delivered = Vec::new();
    server_stdout_reader
        .read_to_end(&mut delivered)
        .await
        .expect("reading observed pipe output");
    client.close().await;
    client_endpoint.close().await;
    server_endpoint.close().await;
    (outcome, delivered)
}

#[tokio::test]
async fn one_shot_pipe_distinguishes_natural_completion_from_a_signal() {
    let (natural, delivered) = observed_pipe_outcome(None).await;
    assert_eq!(natural, None);
    assert_eq!(delivered, b"natural pipe completion");
    assert_eq!(super::pipe_exit_code(natural), 0);

    let (signalled, delivered) = observed_pipe_outcome(Some(ShutdownSignal::Terminate)).await;
    assert_eq!(signalled, Some(ShutdownSignal::Terminate));
    assert!(delivered.is_empty());
    assert_eq!(super::pipe_exit_code(signalled), 143);
    assert_eq!(super::pipe_exit_code(Some(ShutdownSignal::Interrupt)), 130);
}

#[tokio::test]
async fn one_shot_pipe_rolls_back_pre_ack_and_flushes_one_way_stdio() {
    let (server_stdout, mut server_stdout_reader) = tokio::io::duplex(4096);
    let pipe = PipePolicy::sink(server_stdout);
    let first_reservation = Arc::new(AtomicBool::new(true));
    let reserved = Arc::new(Notify::new());
    let policy_cancelled = Arc::new(Notify::new());
    let policy = {
        let first_reservation = first_reservation.clone();
        let reserved = reserved.clone();
        let policy_cancelled = policy_cancelled.clone();
        move |remote, target| {
            let pipe = pipe.clone();
            let first_reservation = first_reservation.clone();
            let reserved = reserved.clone();
            let policy_cancelled = policy_cancelled.clone();
            async move {
                let destination = pipe.connect(remote, target).await?;
                if first_reservation.swap(false, Ordering::AcqRel) {
                    // Hold the first successful policy result before the ACK,
                    // giving the client a deterministic cancellation window.
                    let _notice = DropNotice(policy_cancelled);
                    reserved.notify_one();
                    future::pending::<()>().await;
                }
                Ok::<_, burrow_core::Response>(destination)
            }
        }
    };
    let mut rig = TestRig::start_configured(policy, true, |config| {
        config.exit_after_first_stream = true;
        config.max_streams_per_connection = 1;
    })
    .await;

    // Control and denied requests must not consume the one-shot destination.
    drop(rig.client.ping().await.expect("pinging the pipe server"));
    let denied = rig
        .client
        .open(Target::LocalPort(22))
        .await
        .expect_err("the pipe accepted a non-default target");
    assert_eq!(
        denied.response().map(|response| response.status),
        Some(ResponseStatus::Denied)
    );

    // Cancel a default request after policy reservation but before its ACK.
    // The destination must roll back so the real transfer can claim it.
    let cancelled = {
        let client = rig.client.clone();
        tokio::spawn(async move { client.open(Target::Default).await })
    };
    tokio::time::timeout(PATIENCE, reserved.notified())
        .await
        .expect("the first request never reserved the pipe");
    cancelled.abort();
    assert!(
        cancelled
            .await
            .expect_err("the cancelled request unexpectedly finished")
            .is_cancelled()
    );
    tokio::time::timeout(PATIENCE, policy_cancelled.notified())
        .await
        .expect("the server did not cancel policy evaluation after the stream abort");

    let (client_stdin, mut client_input) = tokio::io::duplex(4096);
    let (client_stdout, mut client_output) = tokio::io::duplex(64);
    let connecting = {
        let client = rig.client.clone();
        tokio::spawn(async move {
            connect_io(
                client,
                Target::Default,
                client_stdin,
                client_stdout,
                future::pending::<ShutdownSignal>(),
            )
            .await
        })
    };
    let receiving = tokio::spawn(async move {
        let mut output = Vec::new();
        server_stdout_reader
            .read_to_end(&mut output)
            .await
            .expect("reading server stdout");
        output
    });

    // An empty server-input half must not manufacture an early FIN. The pipe
    // stays live until delayed client input reaches EOF and is flushed.
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert!(
        !connecting.is_finished(),
        "the one-way server emitted EOF before client input finished"
    );

    let payload: Vec<u8> = (0..512 * 1024).map(|index| (index % 251) as u8).collect();
    client_input
        .write_all(&payload)
        .await
        .expect("writing delayed client input");
    client_input.shutdown().await.expect("ending client input");
    let outcome = tokio::time::timeout(PATIENCE, connecting)
        .await
        .expect("the client pipe did not finish")
        .expect("the client pipe task panicked")
        .expect("the client pipe failed");
    assert_eq!(outcome, None, "the transfer reported a false interruption");
    let delivered = tokio::time::timeout(PATIENCE, receiving)
        .await
        .expect("server stdout did not close after delivery")
        .expect("the server stdout task panicked");
    assert_eq!(delivered, payload);

    let mut unexpected_server_input = Vec::new();
    client_output
        .read_to_end(&mut unexpected_server_input)
        .await
        .expect("reading the one-way client output");
    assert!(
        unexpected_server_input.is_empty(),
        "a one-way pipe sent server input to the client"
    );

    // No shutdown trigger and no connection close: stream-driven completion
    // must return as soon as the committed transfer has flushed cleanly.
    rig.wait_for_server().await;
    rig.finish().await;
}

#[tokio::test]
async fn one_shot_pipe_shutdown_keeps_the_nonzero_server_close() {
    let (server_stdout, _server_stdout_reader) = tokio::io::duplex(64);
    let policy = PipePolicy::sink(server_stdout);
    let mut rig = TestRig::start_configured(policy, true, |config| {
        config.exit_after_first_stream = true;
        config.max_streams_per_connection = 1;
    })
    .await;
    let opened = rig
        .client
        .open(Target::Default)
        .await
        .expect("claiming the one-shot pipe");
    let connection = opened.connection().clone();

    rig.trigger_shutdown();
    match tokio::time::timeout(PATIENCE, connection.closed())
        .await
        .expect("the pipe connection did not close on shutdown")
    {
        ConnectionError::ApplicationClosed(close) => {
            assert_eq!(close.error_code, CLOSE_SHUTDOWN);
            assert_eq!(&close.reason[..], b"server shutting down");
        }
        other => panic!("expected an application shutdown close, got {other:?}"),
    }
    rig.wait_for_server().await;
    drop(opened);
    rig.finish().await;
}

struct FailingWriter;

impl AsyncWrite for FailingWriter {
    fn poll_write(
        self: Pin<&mut Self>,
        _cx: &mut Context<'_>,
        _buffer: &[u8],
    ) -> Poll<io::Result<usize>> {
        Poll::Ready(Err(io::Error::other("pipe sink test failure")))
    }

    fn poll_flush(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Poll::Ready(Ok(()))
    }

    fn poll_shutdown(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Poll::Ready(Ok(()))
    }
}

#[tokio::test]
async fn one_shot_pipe_propagates_destination_failure_from_server() {
    let policy = PipePolicy::sink(FailingWriter);
    let mut rig = TestRig::start_configured(policy, true, |config| {
        config.exit_after_first_stream = true;
        config.max_streams_per_connection = 1;
    })
    .await;
    let mut opened = rig
        .client
        .open(Target::Default)
        .await
        .expect("claiming the failing pipe");

    // QUIC may buffer this successfully before the server observes its local
    // write error, so only the server outcome is asserted.
    let _ = opened.write_all(b"trigger the destination failure").await;
    let _ = opened.shutdown().await;
    let failure = rig
        .server_result()
        .await
        .expect_err("the one-shot server hid its committed stream failure");
    assert!(
        format!("{failure:#}").contains("pipe sink test failure"),
        "unhelpful one-shot failure: {failure:#}"
    );

    drop(opened);
    rig.client.shutdown().await;
    rig.finish().await;
}

#[tokio::test]
async fn stdio_signal_result_is_preserved_for_the_cli() {
    let target = tcp_echo_server().await;
    let rig = TestRig::start(RoutePolicy::new(target, PortSet::default(), false), true).await;
    let (stdin, _stdin_peer) = tokio::io::duplex(64);
    let (stdout, _stdout_peer) = tokio::io::duplex(64);

    let outcome = connect_io(
        rig.client.clone(),
        Target::Default,
        stdin,
        stdout,
        future::ready(ShutdownSignal::Interrupt),
    )
    .await
    .expect("interrupting stdio forwarding");
    assert_eq!(outcome, Some(ShutdownSignal::Interrupt));

    rig.finish().await;
}

async fn expect_echo(mut opened: OpenedStream, payload: &[u8]) {
    opened
        .write_all(payload)
        .await
        .expect("writing through the tunnel");
    opened
        .shutdown()
        .await
        .expect("finishing the tunnel stream");
    let mut echoed = Vec::new();
    tokio::time::timeout(PATIENCE, opened.read_to_end(&mut echoed))
        .await
        .expect("the echo never finished")
        .expect("reading the echo");
    assert_eq!(echoed, payload);
}

#[tokio::test]
async fn default_target_multiplexes_streams_on_one_connection() {
    let target = tcp_echo_server().await;
    let rig = TestRig::start(RoutePolicy::new(target, PortSet::default(), false), true).await;

    let (first, second) = tokio::time::timeout(PATIENCE, async {
        tokio::join!(
            rig.client.open(Target::Default),
            rig.client.open(Target::Default)
        )
    })
    .await
    .expect("opening concurrent streams timed out");
    let first = first.expect("opening the first stream");
    let second = second.expect("opening the second stream");
    assert_eq!(
        first.connection().stable_id(),
        second.connection().stable_id(),
        "concurrent requests must share one QUIC connection"
    );
    let ping = rig
        .client
        .ping()
        .await
        .expect("pinging the shared connection");
    assert_eq!(
        first.connection().stable_id(),
        ping.connection().stable_id(),
        "control requests must reuse the data connection"
    );

    tokio::join!(
        expect_echo(first, b"hello from the default tunnel"),
        expect_echo(second, b"a second stream on the same connection")
    );
    rig.finish().await;
}

#[tokio::test]
async fn local_port_policy_allows_selected_port_and_denies_others() {
    let target = tcp_echo_server().await;
    let allowed: PortSet = target.port().to_string().parse().expect("a one-port set");
    let rig = TestRig::start(RoutePolicy::new(target, allowed, false), true).await;

    let opened = rig
        .client
        .open(Target::LocalPort(target.port()))
        .await
        .expect("opening an allowed loopback port");
    expect_echo(opened, b"allowed loopback service").await;

    let (_reservation, denied) = closed_tcp_target();
    let err = rig
        .client
        .open(Target::LocalPort(denied.port()))
        .await
        .expect_err("an unlisted loopback port must be denied");
    let response = err.response().expect("a structured policy response");
    assert_eq!(response.status, ResponseStatus::Denied);
    assert!(
        response.message().contains("not allowed"),
        "unhelpful denial: {}",
        response.message()
    );

    rig.finish().await;
}

#[tokio::test]
async fn exit_node_routes_ip_and_hostname_only_when_enabled() {
    let target = tcp_echo_server().await;
    let ip_target = Target::Tcp {
        host: Host::Ip(target.ip()),
        port: target.port(),
    };
    let name_target = Target::Tcp {
        host: Host::Name(HostName::new("localhost").unwrap()),
        port: target.port(),
    };

    let disabled = TestRig::start(RoutePolicy::new(target, PortSet::default(), false), true).await;
    for requested in [ip_target.clone(), name_target.clone()] {
        let err = disabled
            .client
            .open(requested)
            .await
            .expect_err("exit routing must be opt-in");
        assert_eq!(
            err.response().map(|response| response.status),
            Some(ResponseStatus::Denied)
        );
    }
    disabled.finish().await;

    let enabled = TestRig::start(RoutePolicy::new(target, PortSet::default(), true), true).await;
    let ip_stream = enabled
        .client
        .open(ip_target)
        .await
        .expect("routing an IP literal through the exit node");
    expect_echo(ip_stream, b"exit by IP").await;
    let name_stream = enabled
        .client
        .open(name_target)
        .await
        .expect("resolving a hostname at the exit node");
    expect_echo(name_stream, b"exit by hostname").await;
    enabled.finish().await;
}

#[tokio::test]
async fn unauthorized_client_gets_close_code_and_structured_denial() {
    let (_closed, target) = closed_tcp_target();
    let rig = TestRig::start(RoutePolicy::new(target, PortSet::default(), false), false).await;

    let connection = rig
        .client_endpoint
        .connect(iroh_utils::dialable_addr(&rig.server_endpoint), ALPN)
        .await
        .expect("the handshake completes before the hook can refuse it");
    match tokio::time::timeout(PATIENCE, connection.closed())
        .await
        .expect("the server never closed the unauthorized connection")
    {
        ConnectionError::ApplicationClosed(close) => {
            assert_eq!(close.error_code, CLOSE_NOT_ALLOWED);
            assert_eq!(&close.reason[..], b"not allowed");
        }
        other => panic!("expected an application close, got {other:?}"),
    }

    let err = rig
        .client
        .open(Target::Default)
        .await
        .expect_err("an unauthorized client must not open a target");
    let response = err.response().expect("a structured authorization response");
    assert_eq!(response.status, ResponseStatus::Denied);
    assert!(
        response.message().contains("not allowed")
            && response
                .message()
                .contains(&rig.client_endpoint.id().to_string()),
        "unhelpful denial: {}",
        response.message()
    );

    rig.finish().await;
}

#[tokio::test]
async fn unreachable_target_returns_a_structured_response() {
    let (_reservation, target) = closed_tcp_target();
    let rig = TestRig::start(RoutePolicy::new(target, PortSet::default(), false), true).await;

    let err = rig
        .client
        .open(Target::Default)
        .await
        .expect_err("the reserved non-listening target must be unreachable");
    let response = err.response().expect("a structured reachability response");
    assert_eq!(response.status, ResponseStatus::Unreachable);
    assert!(
        response.message().contains("connecting to default"),
        "unhelpful reachability error: {}",
        response.message()
    );

    rig.finish().await;
}

#[tokio::test]
async fn graceful_server_shutdown_closes_active_connections_with_shutdown_code() {
    let target = tcp_echo_server().await;
    let mut rig = TestRig::start(RoutePolicy::new(target, PortSet::default(), false), true).await;
    let opened = rig
        .client
        .open(Target::Default)
        .await
        .expect("opening an active stream");
    let connection = opened.connection().clone();

    rig.trigger_shutdown();
    match tokio::time::timeout(PATIENCE, connection.closed())
        .await
        .expect("the shutdown close frame never arrived")
    {
        ConnectionError::ApplicationClosed(close) => {
            assert_eq!(close.error_code, CLOSE_SHUTDOWN);
            assert_eq!(&close.reason[..], b"server shutting down");
        }
        other => panic!("expected an application shutdown close, got {other:?}"),
    }
    rig.wait_for_server().await;
    drop(opened);
    rig.finish().await;
}

/// This covers a failure that used to hang Burrow, and ssh along with it.
/// Stdout cannot signal EOF, so a splice that waits on the local reader after
/// the remote has finished waits forever.
#[tokio::test]
async fn stdio_mode_ends_when_the_remote_finishes() {
    let target = tcp_greeter().await;
    let rig = TestRig::start(RoutePolicy::new(target, PortSet::default(), false), true).await;
    let opened = rig
        .client
        .open(Target::Default)
        .await
        .expect("opening the greeter stream");

    // Stands in for an ssh stdin that has sent its banner and now waits on the
    // far end. It yields nothing more and never ends.
    let (idle_stdin, mut ssh) = tokio::io::duplex(64);
    ssh.write_all(b"SSH-2.0-burrow\r\n").await.expect("banner");
    // The splice drops this half on return, letting the reader observe where
    // the delivered bytes end.
    let (stdout, mut read_back) = tokio::io::duplex(1024);

    tokio::time::timeout(
        PATIENCE,
        opened.splice(idle_stdin, stdout, LocalEof::EndTunnel),
    )
    .await
    .expect("splice never returned after the remote finished")
    .expect("splice failed");

    let mut greeting = Vec::new();
    tokio::time::timeout(PATIENCE, read_back.read_to_end(&mut greeting))
        .await
        .expect("the delivered bytes never ended")
        .expect("reading what the tunnel delivered");
    assert_eq!(greeting, b"hello\n");

    rig.finish().await;
}

/// A TCP write-half FIN must not cancel the still-healthy direction.
#[tokio::test]
async fn tcp_mode_keeps_sending_after_the_remote_finishes() {
    let (target, target_input) = tcp_half_closer().await;
    let rig = TestRig::start(RoutePolicy::new(target, PortSet::default(), false), true).await;
    let opened = rig
        .client
        .open(Target::Default)
        .await
        .expect("opening the half-close stream");
    let (local, mut peer) = tokio::io::duplex(1024);
    let (read, write) = tokio::io::split(local);
    let spliced = tokio::spawn(opened.splice(read, write, LocalEof::HalfClose));

    peer.write_all(b"sent before EOF")
        .await
        .expect("priming the tunnel stream");
    let mut output = Vec::new();
    tokio::time::timeout(PATIENCE, peer.read_to_end(&mut output))
        .await
        .expect("the target's write half never ended")
        .expect("reading target output");
    assert_eq!(output, b"finished writing\n");

    // Reading EOF must not end the other direction. Send only after that EOF
    // so this fails if HalfClose starts behaving like EndTunnel.
    peer.write_all(b"sent after EOF")
        .await
        .expect("writing after remote EOF");
    peer.shutdown().await.expect("finishing local input");
    let received = tokio::time::timeout(PATIENCE, target_input)
        .await
        .expect("the target never finished reading")
        .expect("the target task stopped early");
    assert_eq!(received, b"sent before EOFsent after EOF");

    tokio::time::timeout(PATIENCE, spliced)
        .await
        .expect("splice never returned after the local side closed")
        .expect("splice panicked")
        .expect("splice failed");

    rig.finish().await;
}

#[tokio::test]
async fn key_files_round_trip_and_reject_loose_permissions() {
    let dir = tempfile::tempdir().expect("a scratch directory");
    let path = dir.path().join("burrow").join("key");

    let created = load_or_create_key(&path).expect("creating a key");
    let reloaded = load_or_create_key(&path).expect("reloading the key");
    assert_eq!(
        created.public(),
        reloaded.public(),
        "the key must be stable"
    );
    let mode = std::fs::metadata(&path)
        .expect("key metadata")
        .permissions();
    assert_eq!(mode.mode() & 0o777, 0o600, "a secret key must stay private");

    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644))
        .expect("loosening permissions");
    let err = load_or_create_key(&path).expect_err("a world-readable key must be refused");
    assert!(
        format!("{err:#}").contains("chmod 600"),
        "unhelpful: {err:#}"
    );

    // Burrow reports a key file that an interrupted first run left
    // half-written, rather than taking it at face value.
    std::fs::write(&path, "").expect("truncating the key");
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))
        .expect("restoring permissions");
    let err = load_or_create_key(&path).expect_err("an empty key must be refused");
    assert!(
        format!("{err:#}").contains("32-byte hex"),
        "unhelpful: {err:#}"
    );
}

#[test]
fn config_paths_must_be_absolute() {
    assert_eq!(
        default_key_path_from(
            Some(PathBuf::from(".config")),
            Some(PathBuf::from("/home/someone")),
        )
        .expect("HOME covers a relative XDG_CONFIG_HOME"),
        PathBuf::from("/home/someone/.config/burrow/key"),
    );

    default_key_path_from(Some(PathBuf::from(".config")), Some(PathBuf::from("")))
        .expect_err("a relative path would follow the working directory");

    assert_eq!(
        default_key_path_from(
            Some(PathBuf::from("/xdg")),
            Some(PathBuf::from("/home/someone")),
        )
        .expect("Burrow uses an absolute XDG_CONFIG_HOME"),
        PathBuf::from("/xdg/burrow/key"),
    );
}

#[test]
fn logging_falls_back_when_rust_log_is_unusable() {
    assert!(
        !log_filter_from(0, Some("")).1,
        "an empty RUST_LOG must not silence us"
    );
    assert!(
        !log_filter_from(0, Some("burrow=nonsense")).1,
        "a broken RUST_LOG must not silence us"
    );
    assert!(
        log_filter_from(0, Some("burrow=debug")).1,
        "a usable RUST_LOG must be honoured"
    );
}
