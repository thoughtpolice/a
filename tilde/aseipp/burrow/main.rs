// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! burrow: authenticated byte streams and routed TCP over iroh.
//!
//! Burrow is a small, policy-controlled network tool in the spirit of
//! Tailcat.  A self-contained server address works from a relay or a direct
//! path; each multiplexed stream can select an allowed loopback port or, when
//! the server explicitly enables it, an arbitrary TCP destination.  The same
//! connection powers an SSH `ProxyCommand`, a one-shot server-output sink,
//! local TCP listeners, SOCKS5, and path-aware ping.
//!
//! SSH remains the simplest use:
//!
//! ```text
//! # home
//! burrow serve --allow <laptop-endpoint-id>
//!
//! # laptop ~/.ssh/config
//! Host home
//!     ProxyCommand burrow connect <home-br1-address>
//! ```
//!
//! The address is routing metadata, not a bearer credential.  Mutual TLS
//! authenticates both Ed25519 endpoint identities and the server's allowlist
//! decides which clients may issue requests.  Destination policy is a second,
//! independent check.

#[global_allocator]
static GLOBAL_ALLOCATOR: mimalloc::MiMalloc = mimalloc::MiMalloc;

mod config;
mod duration;
mod endpoint;
mod peer;
mod policy;
mod socks;
mod tunnel;

use std::collections::BTreeSet;
use std::ffi::{OsString, c_int};
use std::io::{self, Write};
use std::net::SocketAddr;
use std::os::unix::process::{CommandExt as _, ExitStatusExt};
use std::path::PathBuf;
use std::process::ExitStatus;
use std::time::Duration;

use anyhow::{Context, Result, anyhow};
use burrow_core::{BurrowAddr, Client, ServerConfig, Target};
use clap::{Parser, Subcommand};
use iroh::{EndpointId, RelayMode, RelayUrl};
use iroh_utils::RELAY_TIMEOUT;
use tokio::net::TcpListener;
use tokio::process::{Child, Command as ProcessCommand};
use tracing::{info, warn};

use config::{default_key_path, init_logging, load_or_create_key};
use duration::HumanDuration;
use endpoint::{Role, bind};
use peer::Peer;
use policy::{PipePolicy, PortSet, RoutePolicy};
use tunnel::{
    ShutdownSignal, ShutdownSignals, connect_listen, connect_stdio, ping, serve,
    serve_configured_observed, task_output,
};

const DEFAULT_TARGET: &str = "127.0.0.1:22";
const DEFAULT_PORTS: &str = "22";
const MAX_LOCAL_CONNECTIONS: usize = 256;
const CHILD_SHUTDOWN_GRACE: Duration = Duration::from_secs(2);
const CHILD_GROUP_POLL: Duration = Duration::from_millis(20);
const SIGKILL: c_int = 9;
const SIGNAL_PROBE: c_int = 0;
const ESRCH: i32 = 3;

unsafe extern "C" {
    /// Sends a signal to a process or process group.  This deliberately avoids
    /// adding a broad libc dependency for one stable POSIX operation.
    fn kill(pid: c_int, signal: c_int) -> c_int;
}

#[derive(Parser)]
#[command(
    name = "burrow",
    version = option_env!("DEPOT_PACKAGE_VERSION")
        .or(option_env!("DEPOT_VERSION"))
        .unwrap_or("dev"),
    about = "Authenticated byte streams over iroh",
    long_about = "Authenticated byte streams over iroh: one-way pipes, SSH ProxyCommand, selected ports, SOCKS5, explicit TCP exit routing, and path-aware ping."
)]
struct Cli {
    /// Log more. Repeat for iroh internals. RUST_LOG overrides verbosity.
    #[arg(short, long, global = true, action = clap::ArgAction::Count)]
    verbose: u8,

    /// Durable endpoint secret, created mode 0600 on first use.
    #[arg(long, global = true, env = "BURROW_KEY", value_name = "PATH")]
    key: Option<PathBuf>,

    /// This endpoint's home relay, and the fallback for a legacy bare ID.
    #[arg(
        long,
        global = true,
        env = "BURROW_RELAY",
        value_name = "URL",
        default_value_t = iroh::defaults::prod::default_na_east_relay().url
    )]
    relay: RelayUrl,

    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Print this machine's endpoint ID for a server allowlist.
    Id,

    /// Print a self-contained address containing ID, relay, and direct hints.
    Address {
        /// Include an externally reachable direct address. Repeat for more.
        #[arg(long, value_name = "IP:PORT")]
        advertise: Vec<SocketAddr>,
    },

    /// Serve authenticated, policy-controlled TCP requests.
    Serve {
        /// Client endpoint allowed to connect. Repeat for more.
        #[arg(long = "allow", required = true, value_name = "ENDPOINT-ID")]
        allow: Vec<EndpointId>,

        /// Target used when a client requests `default`.
        #[arg(long, default_value = DEFAULT_TARGET, value_name = "ADDR")]
        target: SocketAddr,

        /// Loopback ports clients may select, e.g. 22,80,8000-8999 or all.
        #[arg(long, default_value = DEFAULT_PORTS, value_name = "PORTS")]
        ports: PortSet,

        /// Permit arbitrary TCP host:port requests (powerful; off by default).
        #[arg(long)]
        exit_node: bool,

        /// Put an externally reachable direct address in the printed address.
        #[arg(long, value_name = "IP:PORT")]
        advertise: Vec<SocketAddr>,
    },

    /// Copy one authenticated client's stdin to this process's stdout.
    Pipe {
        /// Client endpoint allowed to claim the pipe. Repeat for more.
        #[arg(long = "allow", required = true, value_name = "ENDPOINT-ID")]
        allow: Vec<EndpointId>,

        /// Put an externally reachable direct address in the printed address.
        #[arg(long, value_name = "IP:PORT")]
        advertise: Vec<SocketAddr>,
    },

    /// Forward stdin/stdout or a local listener to one server target.
    Connect {
        /// A self-contained br1 address, or a legacy endpoint ID.
        #[arg(value_name = "SERVER")]
        server: Peer,

        /// `default`, an allowed server-local port, or host:port.
        #[arg(default_value = "default", value_name = "TARGET")]
        target: Target,

        /// Extra direct address to try. Repeat for more.
        #[arg(long, value_name = "IP:PORT")]
        addr: Vec<SocketAddr>,

        /// Accept local TCP connections instead of using stdin/stdout.
        #[arg(long, value_name = "ADDR")]
        listen: Option<SocketAddr>,
    },

    /// Run a local SOCKS5 proxy, optionally for one child command.
    Socks {
        /// Fixed server for server.burrow and exit-node requests. Optional
        /// when destination hostnames are self-contained br1 addresses.
        #[arg(value_name = "SERVER")]
        server: Option<Peer>,

        /// Extra direct address for the fixed SERVER. Repeat for more.
        #[arg(long, value_name = "IP:PORT", requires = "server")]
        addr: Vec<SocketAddr>,

        /// Local SOCKS address; port zero chooses an available port.
        #[arg(long, default_value = "127.0.0.1:0", value_name = "ADDR")]
        listen: SocketAddr,

        /// Command to run with ALL_PROXY/all_proxy set. Use `--` before it.
        #[arg(last = true, allow_hyphen_values = true)]
        command: Vec<OsString>,
    },

    /// Measure protocol reachability and report relay versus direct routing.
    Ping {
        /// A self-contained br1 address, or a legacy endpoint ID.
        #[arg(value_name = "SERVER")]
        server: Peer,

        /// Extra direct address to try. Repeat for more.
        #[arg(long, value_name = "IP:PORT")]
        addr: Vec<SocketAddr>,

        /// Keep probing until iroh selects a direct path.
        #[arg(long)]
        until_direct: bool,

        /// Overall ping or direct-path deadline.
        #[arg(long, default_value = "10s", value_name = "DURATION")]
        timeout: HumanDuration,
    },

    /// Decode and inspect a self-contained Burrow address.
    Parse {
        #[arg(value_name = "BR1-ADDRESS")]
        address: BurrowAddr,
    },
}

async fn run(cli: Cli) -> Result<i32> {
    if let Command::Parse { address } = &cli.command {
        println!("id: {}", address.id());
        println!("relay: {}", address.relay());
        for direct in address.direct_addrs() {
            println!("direct: {direct}");
        }
        return Ok(0);
    }

    let key = load_or_create_key(&key_path(&cli)?)?;
    match cli.command {
        Command::Id => {
            println!("{}", key.public());
            Ok(0)
        }
        Command::Address { advertise } => {
            let address = BurrowAddr::new(key.public(), cli.relay)?.with_direct_addrs(advertise)?;
            println!("{address}");
            Ok(0)
        }
        Command::Serve {
            allow,
            target,
            ports,
            exit_node,
            advertise,
        } => {
            let mut signals =
                ShutdownSignals::new().context("installing shutdown signal handlers")?;
            let allow: BTreeSet<_> = allow.into_iter().collect();
            let allowed = allow.len();
            let endpoint = bind(
                key,
                RelayMode::custom([cli.relay.clone()]),
                Role::Server(allow.clone()),
            )
            .await?;
            let address =
                BurrowAddr::new(endpoint.id(), cli.relay)?.with_direct_addrs(advertise)?;
            info!(id = %endpoint.id(), %target, %ports, allowed, "serving");
            if exit_node {
                warn!(
                    "TCP exit routing is enabled; every allowlisted endpoint can request arbitrary destinations"
                );
            }
            println!("{address}");
            std::io::stdout()
                .flush()
                .context("printing the Burrow address")?;
            info!("dial with: burrow connect {address}");

            let relay_report = tokio::spawn(report_relay(endpoint.clone()));
            let result = serve(
                endpoint.clone(),
                allow,
                RoutePolicy::new(target, ports, exit_node),
                signals.recv(),
            )
            .await;
            relay_report.abort();
            let _ = task_output(relay_report.await);
            endpoint.close().await;
            result?;
            Ok(0)
        }
        Command::Pipe { allow, advertise } => {
            let mut signals =
                ShutdownSignals::new().context("installing shutdown signal handlers")?;
            let allow: BTreeSet<_> = allow.into_iter().collect();
            let allowed = allow.len();
            let endpoint = bind(
                key,
                RelayMode::custom([cli.relay.clone()]),
                Role::Server(allow.clone()),
            )
            .await?;
            let address =
                BurrowAddr::new(endpoint.id(), cli.relay)?.with_direct_addrs(advertise)?;
            // stdout belongs exclusively to the remote byte stream. Keep the
            // address copyable while making shell pipelines binary-clean.
            {
                let mut stderr = std::io::stderr().lock();
                writeln!(stderr, "{address}").context("printing the Burrow pipe address")?;
                stderr.flush().context("flushing the Burrow pipe address")?;
            }
            info!(id = %endpoint.id(), allowed, "serving a one-shot output pipe");

            let mut config = ServerConfig::new(allow);
            config.exit_after_first_stream = true;
            config.max_streams_per_connection = 1;
            let relay_report = tokio::spawn(report_relay(endpoint.clone()));
            let result = serve_configured_observed(
                endpoint.clone(),
                config,
                PipePolicy::stdio(),
                signals.recv(),
            )
            .await;
            relay_report.abort();
            let _ = task_output(relay_report.await);
            endpoint.close().await;
            Ok(pipe_exit_code(result?))
        }
        Command::Connect {
            server,
            target,
            addr,
            listen,
        } => {
            let mut signals =
                ShutdownSignals::new().context("installing shutdown signal handlers")?;
            let endpoint = bind(key, RelayMode::custom([cli.relay.clone()]), Role::Client).await?;
            let client = Client::new(endpoint.clone(), server.endpoint_addr(cli.relay, addr));
            let result = match listen {
                Some(listen) => {
                    connect_listen(client.clone(), target, listen, signals.recv()).await
                }
                None => connect_stdio(client.clone(), target, signals.recv()).await,
            };
            let result = match result {
                Ok(None) => {
                    client.close().await;
                    Ok(0)
                }
                Ok(Some(signal)) => {
                    // The tunnel adapter has already interrupted its streams;
                    // retain both the nonzero connection close and shell
                    // signal status instead of replacing them with success.
                    client.shutdown().await;
                    Ok(signal.exit_code())
                }
                Err(err) => {
                    // A failed splice has just reset its stream halves.
                    // Preserve that abnormal outcome at connection level
                    // instead of racing it with code-zero CONNECTION_CLOSE.
                    client.shutdown().await;
                    Err(err)
                }
            };
            endpoint.close().await;
            result
        }
        Command::Socks {
            server,
            addr,
            listen,
            command,
        } => {
            let endpoint = bind(key, RelayMode::custom([cli.relay.clone()]), Role::Client).await?;
            let fixed = server
                .map(|server| Client::new(endpoint.clone(), server.endpoint_addr(cli.relay, addr)));
            let router = socks::SocksRouter::new(endpoint.clone(), fixed);
            let result = run_socks(router, listen, command).await;
            endpoint.close().await;
            result
        }
        Command::Ping {
            server,
            addr,
            until_direct,
            timeout,
        } => {
            let mut signals =
                ShutdownSignals::new().context("installing shutdown signal handlers")?;
            let endpoint = bind(key, RelayMode::custom([cli.relay.clone()]), Role::Client).await?;
            let client = Client::new(endpoint.clone(), server.endpoint_addr(cli.relay, addr));
            let result: Result<Option<ShutdownSignal>> = tokio::select! {
                biased;
                signal = signals.recv() => {
                    client.shutdown().await;
                    Ok(Some(signal))
                }
                result = ping(&client, until_direct, timeout.0) => result.map(|()| None),
            };
            let result = match result {
                Ok(Some(signal)) => {
                    client.shutdown().await;
                    Ok(signal.exit_code())
                }
                Ok(None) => {
                    client.close().await;
                    Ok(0)
                }
                Err(err) => {
                    client.close().await;
                    Err(err)
                }
            };
            endpoint.close().await;
            result
        }
        Command::Parse { .. } => unreachable!("handled before loading an identity"),
    }
}

async fn report_relay(endpoint: iroh::Endpoint) {
    match tokio::time::timeout(RELAY_TIMEOUT, iroh_utils::home_relay(&endpoint)).await {
        Ok(Some(relay)) => info!(%relay, "relay connected"),
        Ok(None) if endpoint.is_closed() => {}
        _ => warn!(
            "no relay connection after {RELAY_TIMEOUT:?}; only a direct address currently reaches this endpoint"
        ),
    }
}

fn pipe_exit_code(signal: Option<ShutdownSignal>) -> i32 {
    signal.map_or(0, ShutdownSignal::exit_code)
}

async fn run_socks(
    router: socks::SocksRouter,
    listen: SocketAddr,
    command: Vec<OsString>,
) -> Result<i32> {
    // Install signal handlers before creating either the listener task or a
    // child process group. Otherwise a signal in that setup window would take
    // its default action and leave those children behind.
    let mut signals = ShutdownSignals::new().context("installing shutdown signal handlers")?;
    let listener = TcpListener::bind(listen)
        .await
        .with_context(|| format!("listening for SOCKS on {listen}"))?;
    let mut proxy = socks::spawn_accept_loop(listener, router.clone(), MAX_LOCAL_CONNECTIONS)?;
    let local = proxy.local_addr();
    let proxy_url = format!("socks5h://{local}");

    // Capture every post-spawn failure as data so the one cleanup path below
    // always stops the listener and drains its handler tasks.
    let mut interrupted = false;
    let result: Result<i32> = async {
        info!(%proxy_url, "SOCKS5 proxy listening");
        if !local.ip().is_loopback() {
            warn!(
                "the SOCKS listener is not loopback and has no authentication; anyone who reaches it can use the tunnel"
            );
        } else {
            warn!(
                "the SOCKS listener has no per-user authentication; other local users may be able to use it"
            );
        }

        if command.is_empty() {
            println!("{proxy_url}");
            std::io::stdout()
                .flush()
                .context("printing the SOCKS address")?;
            return tokio::select! {
                result = proxy.wait() => {
                    result.context("running the SOCKS listener")?;
                    Err(anyhow!("SOCKS listener stopped unexpectedly"))
                }
                signal = signals.recv() => {
                    interrupted = true;
                    Ok(signal.exit_code())
                }
            };
        }

        let mut child = ProcessCommand::new(&command[0]);
        child
            .args(&command[1..])
            .env("ALL_PROXY", &proxy_url)
            .env("all_proxy", &proxy_url)
            .kill_on_drop(true);
        // Give the child a private process group so signal forwarding and the
        // eventual hard stop include descendants, not just the shell wrapper.
        child.as_std_mut().process_group(0);
        let child = child
            .spawn()
            .with_context(|| format!("starting {:?}", command[0]))?;
        let mut child = ChildGroup::new(child)?;

        enum ChildEvent {
            Exited(io::Result<ExitStatus>),
            Proxy(io::Result<usize>),
            Signal(ShutdownSignal),
        }

        let event = tokio::select! {
            biased;
            status = child.child.wait() => ChildEvent::Exited(status),
            result = proxy.wait() => ChildEvent::Proxy(result),
            signal = signals.recv() => ChildEvent::Signal(signal),
        };
        let process_group = child.process_group;
        let code = match event {
            ChildEvent::Exited(status) => {
                let status = status.context("waiting for the SOCKS child")?;
                // A shell or supervisor may exit while background descendants
                // remain. They belong to Burrow's private process group too.
                match stop_child_group_interruptible(
                    &mut child.child,
                    process_group,
                    Some(status),
                    ShutdownSignal::Terminate,
                    async {},
                    &mut signals,
                )
                .await?
                {
                    GroupStop::Complete(code) => code,
                    GroupStop::Interrupted(signal) => {
                        interrupted = true;
                        signal.exit_code()
                    }
                }
            }
            ChildEvent::Proxy(result) => {
                let stopped = stop_child_group_interruptible(
                    &mut child.child,
                    process_group,
                    None,
                    ShutdownSignal::Terminate,
                    async {},
                    &mut signals,
                )
                .await
                .context("stopping the child after the SOCKS listener failed")?;
                // The process group is gone; never leave the fallback guard
                // armed while propagating the listener error below, because
                // its numeric PGID could eventually be reused.
                child.disarm();
                if let GroupStop::Interrupted(signal) = stopped {
                    interrupted = true;
                    return Ok(signal.exit_code());
                }
                result.context("running the SOCKS listener")?;
                return Err(anyhow!(
                    "SOCKS listener stopped while the child was running"
                ));
            }
            ChildEvent::Signal(signal) => {
                interrupted = true;
                match stop_child_group_interruptible(
                    &mut child.child,
                    process_group,
                    None,
                    signal,
                    async {},
                    &mut signals,
                )
                .await?
                {
                    GroupStop::Complete(code) => code,
                    GroupStop::Interrupted(second) => {
                        second.exit_code()
                    }
                }
            }
        };
        child.disarm();
        Ok(code)
    }
    .await;

    // Cooperative listener shutdown aborts *and joins* every handler, ensuring
    // OpenedStream/splice guards have reset truncated streams before any normal
    // connection close. If handlers had to be forced down, retain an explicit
    // nonzero connection outcome as an additional integrity boundary.
    let proxy_shutdown = proxy.shutdown().await;
    let force_close = interrupted
        || result.is_err()
        || proxy_shutdown.is_err()
        || proxy_shutdown
            .as_ref()
            .is_ok_and(|cancelled| *cancelled != 0);
    router.close_all(force_close).await;

    match (result, proxy_shutdown) {
        (Ok(code), Ok(_)) => Ok(code),
        (Ok(_), Err(err)) => Err(err).context("stopping the SOCKS listener"),
        (Err(err), Ok(_)) => Err(err),
        (Err(err), Err(stop_err)) => {
            warn!(error = %stop_err, "also failed to stop the SOCKS listener");
            Err(err)
        }
    }
}

/// Synchronous last-resort ownership for a spawned child process group.
///
/// Ordinary paths use `stop_child_group` and disarm this guard after reaping.
/// Any intervening `?` or panic still sends SIGKILL to the group and direct
/// child rather than detaching arbitrary work.
struct ChildGroup {
    child: Child,
    process_group: c_int,
    armed: bool,
}

impl ChildGroup {
    fn new(child: Child) -> Result<Self> {
        let process_group = child
            .id()
            .and_then(|id| c_int::try_from(id).ok())
            .ok_or_else(|| anyhow!("the child has no representable process ID"))?;
        Ok(Self {
            child,
            process_group,
            armed: true,
        })
    }

    fn disarm(&mut self) {
        self.armed = false;
    }
}

impl Drop for ChildGroup {
    fn drop(&mut self) {
        if self.armed {
            let _ = signal_process_group(self.process_group, SIGKILL);
            let _ = self.child.start_kill();
        }
    }
}

enum GroupStop {
    Complete(i32),
    Interrupted(ShutdownSignal),
}

/// Keeps the registered receivers live while graceful child cleanup runs.
/// A signal arriving in that phase is an explicit request to stop waiting:
/// forward it, force the private group down, and preserve that signal as the
/// command's conventional shell exit code. This also gives a second Ctrl-C a
/// deterministic effect despite Tokio retaining its process-wide handler.
async fn stop_child_group_interruptible<F>(
    child: &mut Child,
    process_group: c_int,
    known_status: Option<ExitStatus>,
    signal: ShutdownSignal,
    cleanup: F,
    signals: &mut ShutdownSignals,
) -> Result<GroupStop>
where
    F: std::future::Future<Output = ()>,
{
    let interrupted = {
        let stopping = stop_child_group(child, process_group, known_status, signal, cleanup);
        tokio::pin!(stopping);
        tokio::select! {
            // If teardown and a signal race, completion wins so the PGID is
            // never touched after ownership has ended.
            biased;
            result = &mut stopping => return result.map(GroupStop::Complete),
            signal = signals.recv() => signal,
        }
    };

    signal_process_group(process_group, interrupted.number()).with_context(|| {
        format!(
            "forwarding signal {} during child cleanup",
            interrupted.number()
        )
    })?;
    signal_process_group(process_group, SIGKILL)
        .context("forcing the child process group down after another signal")?;
    if child
        .try_wait()
        .context("rechecking the interrupted child")?
        .is_none()
    {
        // The leader might have moved itself out of its original group.
        child
            .start_kill()
            .context("forcing the child process down")?;
        child
            .wait()
            .await
            .context("waiting for the force-stopped child")?;
    }
    Ok(GroupStop::Interrupted(interrupted))
}

/// Delivers a shutdown signal to the whole child group, then gives its leader
/// and descendants one shared grace period before forcing down survivors. A
/// known leader status is preserved while the remaining group is still cleaned
/// up.
async fn stop_child_group<F>(
    child: &mut Child,
    process_group: c_int,
    known_status: Option<ExitStatus>,
    signal: ShutdownSignal,
    cleanup: F,
) -> Result<i32>
where
    F: std::future::Future<Output = ()>,
{
    let mut status = known_status;
    if status.is_none() {
        status = child.try_wait().context("checking child status")?;
    }

    // Even when the leader has already been reaped, its process group remains
    // addressable for as long as a descendant exists. Never let the leader's
    // completion bypass descendant teardown.
    signal_process_group(process_group, signal.number())
        .with_context(|| format!("forwarding signal {} to the child", signal.number()))?;
    let deadline = tokio::time::Instant::now() + CHILD_SHUTDOWN_GRACE;
    cleanup.await;

    let (status, group_was_killed) = match status {
        Some(status) => (status, false),
        None => match tokio::time::timeout_at(deadline, child.wait()).await {
            Ok(status) => (
                status.context("waiting for the child after shutdown")?,
                false,
            ),
            Err(_) => {
                // The wait future is cancellation-safe, but recheck to avoid a
                // kill racing a child that exited exactly at the deadline.
                if let Some(status) = child.try_wait().context("rechecking child status")? {
                    (status, false)
                } else {
                    signal_process_group(process_group, SIGKILL)
                        .context("killing the child process group after the grace period")?;
                    // A command may have moved itself out of the process group.
                    // Retain direct ownership of the leader in that case.
                    child.start_kill().context("killing the child directly")?;
                    (
                        child.wait().await.context("waiting for the killed child")?,
                        true,
                    )
                }
            }
        },
    };
    // The group leader can exit while a shell-spawned descendant ignores the
    // forwarded signal.  Keep the same deadline for the whole group, then
    // force any remainder down.  This is what makes child-command mode own a
    // process tree rather than only its immediate wrapper.
    if !group_was_killed {
        wait_for_child_group(process_group, deadline).await?;
    }
    Ok(child_exit_code(status))
}

async fn wait_for_child_group(process_group: c_int, deadline: tokio::time::Instant) -> Result<()> {
    loop {
        if !process_group_exists(process_group).context("checking the child process group")? {
            return Ok(());
        }
        let now = tokio::time::Instant::now();
        if now >= deadline {
            signal_process_group(process_group, SIGKILL)
                .context("killing remaining child-group processes after the grace period")?;
            return Ok(());
        }
        tokio::time::sleep(CHILD_GROUP_POLL.min(deadline - now)).await;
    }
}

fn process_group_exists(process_group: c_int) -> io::Result<bool> {
    // SAFETY: as in signal_process_group below, there are no pointers and the
    // negative PID names the private process group.  Signal zero only probes.
    if unsafe { kill(-process_group, SIGNAL_PROBE) } == 0 {
        return Ok(true);
    }
    let err = io::Error::last_os_error();
    if err.raw_os_error() == Some(ESRCH) {
        Ok(false)
    } else {
        Err(err)
    }
}

fn signal_process_group(process_group: c_int, signal: c_int) -> io::Result<()> {
    // SAFETY: `kill` has no pointer arguments.  `process_group` is the PID
    // returned by the just-spawned child, and negating it selects that child's
    // private process group.  Signal values are fixed POSIX constants.
    if unsafe { kill(-process_group, signal) } == 0 {
        return Ok(());
    }
    let err = io::Error::last_os_error();
    if err.raw_os_error() == Some(ESRCH) {
        // A child can exit between `try_wait` and `kill`; its subsequent wait
        // still supplies the exact status.  Treat that race as delivered.
        Ok(())
    } else {
        Err(err)
    }
}

fn child_exit_code(status: ExitStatus) -> i32 {
    status
        .code()
        .or_else(|| status.signal().map(|signal| 128 + signal))
        .unwrap_or(1)
}

fn key_path(cli: &Cli) -> Result<PathBuf> {
    match &cli.key {
        Some(path) => Ok(path.clone()),
        None => default_key_path(),
    }
}

#[tokio::main]
async fn main() -> ! {
    let cli = Cli::parse();
    init_logging(cli.verbose);
    let code = match run(cli).await {
        Ok(code) => code,
        Err(err) => {
            eprintln!("burrow: {err:#}");
            1
        }
    };
    // Tokio cannot cancel a blocking stdin read.  Exit after flushing so an
    // ended ProxyCommand does not wait for that runtime worker indefinitely.
    std::io::stdout().flush().ok();
    std::process::exit(code)
}

#[cfg(test)]
#[path = "tests/main_cli_parse.rs"]
mod cli_parse_tests;
#[cfg(test)]
#[path = "tests/main_process_lifecycle.rs"]
mod process_lifecycle_tests;
#[cfg(test)]
#[path = "tests/integration.rs"]
mod tests;
