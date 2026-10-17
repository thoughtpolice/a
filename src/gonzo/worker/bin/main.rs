// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! gonzo-worker: run actions for a gonzo daemon on another machine.
//!
//! ```text
//! # on the daemon's machine
//! gonzo serve      # says: gonzo-worker --join acid-bunny-crown-dwarf-ivory-swamp
//! gonzo code       # says it again
//!
//! # on this one
//! gonzo-worker --join acid-bunny-crown-dwarf-ivory-swamp
//! ```
//!
//! The worker finds the daemon by its join code on the mainline DHT, or
//! takes its ticket (`gonzo ticket`) where the DHT cannot be reached. It
//! dials the daemon over iroh, through relays and NATs as need
//! be, and runs the actions the daemon's scheduler sends it, reading
//! inputs from the daemon's store and writing outputs back. It offers this
//! machine's OS and architecture as Buck names them, `container-image=host`,
//! `container-image=empty` where it can run actions in an empty root, any
//! `--image` it runs inside, and any `--property` given; it keeps a cache of
//! input files, so each is fetched once. When the connection drops it dials
//! again.

#[global_allocator]
static GLOBAL: mimalloc::MiMalloc = mimalloc::MiMalloc;

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context as _, Result};
use clap::Parser;
use protos::build::bazel::remote::execution::v2::platform::Property;

#[derive(Parser, Debug)]
#[command(
    name = "gonzo-worker",
    version = option_env!("depot_VERSION").unwrap_or("dev")
)]
struct Args {
    /// The daemon to join: its join code (`gonzo code` on its machine) or
    /// its ticket (`gonzo ticket`).
    #[arg(long, env = "GONZO_WORKER_JOIN", value_parser = join, value_name = "CODE|TICKET")]
    join: Join,

    /// How many actions to run at once (default: one per CPU this process
    /// may use).
    #[arg(long, env = "GONZO_WORKER_SLOTS")]
    slots: Option<usize>,

    /// Where to keep the worker's identity, its file cache, and the actions
    /// it runs. Defaults to `gonzo-worker` under $XDG_CACHE_HOME (or
    /// ~/.cache).
    #[arg(long, env = "GONZO_WORKER_DIR")]
    dir: Option<PathBuf>,

    /// Most GiB of input files to keep.
    #[arg(long, default_value_t = 20, env = "GONZO_WORKER_CACHE_GIB")]
    cache_gib: u64,

    /// A platform property to offer besides this machine's own, as
    /// NAME=VALUE; may be given more than once. Images are offered with
    /// --image instead.
    #[arg(long = "property", value_parser = property)]
    properties: Vec<Property>,

    /// A container image this worker runs inside: actions asking for
    /// `container-image=IMAGE` run here on the host as it is, as
    /// `container-image=host` actions do. May be given more than once.
    #[arg(long = "image", value_name = "IMAGE")]
    images: Vec<String>,

    /// How the worker appears in the daemon's logs and in results
    /// (default: the host name).
    #[arg(long)]
    name: Option<String>,

    /// The timeout, in seconds, of an action that sets none.
    #[arg(long, default_value_t = 3600)]
    action_timeout: u64,

    /// The longest timeout, in seconds, an action may set.
    #[arg(long, default_value_t = 4 * 3600)]
    max_action_timeout: u64,

    /// Which events the log shows: a level, or directives in `RUST_LOG`
    /// syntax.
    #[arg(long, default_value = "info", env = "GONZO_LOG")]
    log: String,
}

/// The daemon `--join` names.
#[derive(Clone, Debug)]
enum Join {
    Code(mesh::JoinCode),
    Ticket(mesh::JoinTicket),
}

fn join(text: &str) -> Result<Join, String> {
    // A ticket starts with `endpoint`, which no code does.
    if text.trim_start().starts_with("endpoint") {
        return text.parse().map(Join::Ticket).map_err(|e| e.to_string());
    }
    text.parse().map(Join::Code).map_err(|e| e.to_string())
}

fn property(text: &str) -> Result<Property, String> {
    let (name, value) = text
        .split_once('=')
        .ok_or_else(|| format!("{text:?} is not NAME=VALUE"))?;
    // Offered without a way to run it, the image would take actions only
    // to fail them.
    if name == "container-image" {
        return Err(format!("offer an image with --image {value}"));
    }
    Ok(Property {
        name: name.to_string(),
        value: value.to_string(),
    })
}

/// The longest wait between attempts to reach the daemon.
const MAX_BACKOFF: Duration = Duration::from_secs(60);

fn main() -> Result<()> {
    let args = Args::parse();
    // Before the runtime starts: this sizes it, raises the open file limit
    // and fits the allocator to a memory limit.
    let runtime_info = runtime::init();
    tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .worker_threads(runtime_info.effective_cpus)
        .build()
        .context("failed to start the tokio runtime")?
        .block_on(serve(args, runtime_info))
}

async fn serve(args: Args, runtime_info: runtime::RuntimeInfo) -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::builder()
                .parse(&args.log)
                .with_context(|| format!("invalid --log filter {:?}", args.log))?,
        )
        .init();
    runtime_info.emit_diagnostics();

    let dir = match args.dir {
        Some(dir) => dir,
        None => cache_home()?.join("gonzo-worker"),
    };
    let identity = mesh::load_or_create_identity(&dir.join("identity"))
        .with_context(|| format!("failed to read or make {}/identity", dir.display()))?;
    let endpoint = mesh::bind(identity, false, iroh_dial::Global::default())
        .await
        .context("failed to bind an iroh endpoint")?;

    let mut properties = worker::host_properties();
    properties.extend(args.properties);
    let mut images = worker::host_images();
    images.extend(args.images.into_iter().map(worker::Image::host));
    let name = args
        .name
        .or_else(worker::host_name)
        .unwrap_or_else(|| endpoint.id().fmt_short().to_string());
    let slots = args.slots.unwrap_or(runtime_info.effective_cpus);
    let worker = Arc::new(worker::Worker::new(worker::Config {
        name,
        properties,
        images,
        slots,
        dir: dir.join("work"),
        cache_bytes: args.cache_gib * 1024 * 1024 * 1024,
        default_timeout: Duration::from_secs(args.action_timeout),
        max_timeout: Duration::from_secs(args.max_action_timeout),
    })?);
    let daemon = match args.join {
        Join::Ticket(ticket) => Daemon::Ticket(ticket),
        Join::Code(code) => Daemon::Cluster {
            rendezvous: mesh::Cluster::rendezvous(&endpoint, None)
                .context("failed to join the DHT to find the cluster's daemons")?,
            // Slow on purpose; see mesh::JoinCode.
            cluster: tokio::task::spawn_blocking(move || code.cluster()).await?,
        },
    };
    tracing::info!(
        worker = %endpoint.id(),
        daemon = %daemon,
        slots,
        dir = %dir.display(),
        "gonzo-worker starting"
    );

    let (stop, stopping) = tokio::sync::watch::channel(false);
    tokio::spawn(async move {
        shutdown().await;
        tracing::info!("gonzo-worker stopping");
        stop.send_replace(true);
    });
    let mut backoff = Duration::from_secs(1);
    'serving: loop {
        let candidates = match daemon.candidates().await {
            Ok(candidates) if candidates.is_empty() => {
                tracing::warn!("no daemon has announced itself under {daemon} yet");
                Vec::new()
            }
            Ok(candidates) => candidates,
            Err(e) => {
                tracing::warn!("failed to look for daemons: {e:#}");
                Vec::new()
            }
        };
        for (target, key) in candidates {
            match session(&endpoint, target, &key, &worker, stopping.clone()).await {
                Ok(Ended::Shutdown) => break 'serving,
                Ok(Ended::Lost) => {
                    tracing::warn!("lost the daemon");
                    backoff = Duration::from_secs(1);
                    break;
                }
                Err(e) => match (e.downcast_ref::<mesh::JoinError>(), &daemon) {
                    // A ticket that does not work will not start working.
                    (
                        Some(mesh::JoinError::UnknownWorker | mesh::JoinError::UnknownDaemon),
                        Daemon::Ticket(_),
                    ) => {
                        return Err(
                            e.context("the daemon and this worker do not share the ticket's key")
                        );
                    }
                    // In a cluster, anyone who knows the code can announce
                    // themselves; try the next.
                    _ => tracing::warn!("{e:#}"),
                },
            }
        }
        tracing::info!("trying again in {}s", backoff.as_secs());
        if tokio::time::timeout(backoff, stopped(stopping.clone()))
            .await
            .is_ok()
        {
            break;
        }
        backoff = (backoff * 2).min(MAX_BACKOFF);
    }
    endpoint.close().await;
    Ok(())
}

/// The daemon to join: the one a ticket names, or any of a cluster's.
enum Daemon {
    Ticket(mesh::JoinTicket),
    Cluster {
        cluster: mesh::Cluster,
        rendezvous: mesh::Rendezvous,
    },
}

impl Daemon {
    /// Where to dial, and the key to join with, in the order to try them.
    async fn candidates(&self) -> Result<Vec<(mesh::EndpointAddr, mesh::JoinKey)>> {
        Ok(match self {
            Self::Ticket(ticket) => vec![(ticket.daemon.clone(), ticket.key.clone())],
            Self::Cluster {
                cluster,
                rendezvous,
            } => cluster
                .daemons(rendezvous)
                .await?
                .into_iter()
                .map(|id| (mesh::EndpointAddr::new(id), cluster.key()))
                .collect(),
        })
    }
}

impl std::fmt::Display for Daemon {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Ticket(ticket) => write!(f, "{}", ticket.daemon.id),
            Self::Cluster { cluster, .. } => write!(f, "code {}", cluster.hint()),
        }
    }
}

/// How a session ended without failing.
enum Ended {
    /// The worker is stopping.
    Shutdown,
    /// The daemon went away, or the connection did.
    Lost,
}

/// Resolves once `stopping` says so.
async fn stopped(mut stopping: tokio::sync::watch::Receiver<bool>) {
    let _ = stopping.wait_for(|stopping| *stopping).await;
}

/// Join the daemon and serve it until the connection ends, or the worker
/// does.
async fn session(
    endpoint: &mesh::Endpoint,
    daemon: mesh::EndpointAddr,
    key: &mesh::JoinKey,
    worker: &Arc<worker::Worker>,
    stopping: tokio::sync::watch::Receiver<bool>,
) -> Result<Ended> {
    let joining = async {
        let conn = iroh_dial::dial(endpoint, daemon.into(), mesh::ALPN)
            .await
            .context("failed to reach the daemon")?;
        mesh::join(&conn, endpoint.id(), key).await?;
        anyhow::Ok(conn)
    };
    let conn = tokio::select! {
        conn = joining => conn?,
        () = stopped(stopping.clone()) => return Ok(Ended::Shutdown),
    };
    tracing::info!(daemon = %conn.remote_id(), "joined the daemon");
    let served = worker
        .serve(mesh::channel(conn.clone()), stopped(stopping.clone()))
        .await;
    conn.close(0u32.into(), b"done");
    served?;
    Ok(if *stopping.borrow() {
        Ended::Shutdown
    } else {
        Ended::Lost
    })
}

/// Resolves on SIGINT or SIGTERM.
async fn shutdown() {
    let mut sigterm = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
        .expect("failed to install a SIGTERM handler");
    tokio::select! {
        _ = tokio::signal::ctrl_c() => {}
        _ = sigterm.recv() => {}
    }
}

/// The XDG cache directory.
fn cache_home() -> Result<PathBuf> {
    let absolute = |var: &str| {
        std::env::var_os(var)
            .map(PathBuf::from)
            .filter(|dir| dir.is_absolute())
    };
    absolute("XDG_CACHE_HOME")
        .or_else(|| absolute("HOME").map(|home| home.join(".cache")))
        .context("no --dir given, and neither XDG_CACHE_HOME nor HOME names a directory")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn properties_are_name_equals_value() {
        let p = property("gpu=nvidia").unwrap();
        assert_eq!((p.name.as_str(), p.value.as_str()), ("gpu", "nvidia"));
        let p = property("pool=a=b").unwrap();
        assert_eq!(p.value, "a=b");
        assert!(property("gpu").is_err());
        let refused = property("container-image=docker://x").unwrap_err();
        assert!(refused.contains("--image docker://x"), "{refused}");
    }

    #[test]
    fn join_takes_a_code_or_a_ticket() {
        assert!(Args::try_parse_from(["gonzo-worker"]).is_err());
        let code = mesh::JoinCode::generate();
        let parsed = Args::try_parse_from(["gonzo-worker", "--join", &code.to_string()]).unwrap();
        assert!(matches!(parsed.join, Join::Code(c) if c == code));
        let ticket = mesh::JoinTicket {
            daemon: mesh::EndpointAddr::new(mesh::SecretKey::generate().public()),
            key: mesh::JoinKey::generate(),
        };
        let parsed = Args::try_parse_from(["gonzo-worker", "--join", &ticket.to_string()]).unwrap();
        assert!(matches!(parsed.join, Join::Ticket(t) if t == ticket));
        let typo = join("acid-acorn-acre-acts-afar-xyzzy").unwrap_err();
        assert!(typo.contains("xyzzy"), "{typo}");
        assert!(join("endpointabc").is_err());
    }
}
