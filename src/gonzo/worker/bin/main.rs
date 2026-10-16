// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! gonzo-worker: run actions for a gonzo daemon on another machine.
//!
//! ```text
//! # on the daemon's machine
//! gonzo serve --accept-workers
//! gonzo ticket
//!
//! # on this one
//! gonzo-worker --join <ticket>
//! ```
//!
//! The worker dials the daemon over iroh, through relays and NATs as need
//! be, and runs the actions the daemon's scheduler sends it, reading
//! inputs from the daemon's store and writing outputs back. It offers this
//! machine's OS and architecture as Buck names them, `container-image=host`,
//! and any `--property` given; it keeps a cache of input files, so each is
//! fetched once. When the connection drops it dials again.

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
    /// The ticket of the daemon to join, from `gonzo ticket` on its machine.
    #[arg(long, env = "GONZO_WORKER_JOIN")]
    join: mesh::JoinTicket,

    /// How many actions to run at once (default: one per CPU).
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
    /// NAME=VALUE; may be given more than once.
    #[arg(long = "property", value_parser = property)]
    properties: Vec<Property>,

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

fn property(text: &str) -> Result<Property, String> {
    let (name, value) = text
        .split_once('=')
        .ok_or_else(|| format!("{text:?} is not NAME=VALUE"))?;
    Ok(Property {
        name: name.to_string(),
        value: value.to_string(),
    })
}

/// The longest wait between attempts to reach the daemon.
const MAX_BACKOFF: Duration = Duration::from_secs(60);

#[tokio::main]
async fn main() -> Result<()> {
    let args = Args::parse();
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::builder()
                .parse(&args.log)
                .with_context(|| format!("invalid --log filter {:?}", args.log))?,
        )
        .init();

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
    let name = args.name.unwrap_or_else(|| {
        std::fs::read_to_string("/proc/sys/kernel/hostname")
            .map(|h| h.trim().to_string())
            .unwrap_or_else(|_| endpoint.id().fmt_short().to_string())
    });
    let slots = args
        .slots
        .unwrap_or_else(|| std::thread::available_parallelism().map_or(1, std::num::NonZero::get));
    let worker = Arc::new(worker::Worker::new(worker::Config {
        name,
        properties,
        slots,
        dir: dir.join("work"),
        cache_bytes: args.cache_gib * 1024 * 1024 * 1024,
        base_environment: worker::host_environment(),
        default_timeout: Duration::from_secs(args.action_timeout),
        max_timeout: Duration::from_secs(args.max_action_timeout),
    })?);
    tracing::info!(
        worker = %endpoint.id(),
        daemon = %args.join.daemon.id,
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
    loop {
        match session(&endpoint, &args.join, &worker, stopping.clone()).await {
            Ok(Ended::Shutdown) => break,
            Ok(Ended::Lost) => {
                tracing::warn!("lost the daemon");
                backoff = Duration::from_secs(1);
            }
            Err(e) => match e.downcast_ref::<mesh::JoinError>() {
                // A ticket that does not work will not start working.
                Some(mesh::JoinError::UnknownWorker | mesh::JoinError::UnknownDaemon) => {
                    return Err(
                        e.context("the daemon and this worker do not share the ticket's key")
                    );
                }
                _ => tracing::warn!("{e:#}"),
            },
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
    ticket: &mesh::JoinTicket,
    worker: &Arc<worker::Worker>,
    stopping: tokio::sync::watch::Receiver<bool>,
) -> Result<Ended> {
    let joining = async {
        let conn = iroh_dial::dial(endpoint, ticket.daemon.clone().into(), mesh::ALPN)
            .await
            .context("failed to reach the daemon")?;
        mesh::join(&conn, endpoint.id(), &ticket.key).await?;
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
        let p = property("container-image=docker://x=y").unwrap();
        assert_eq!(p.value, "docker://x=y");
        assert!(property("gpu").is_err());
    }

    #[test]
    fn a_ticket_is_required() {
        assert!(Args::try_parse_from(["gonzo-worker"]).is_err());
    }
}
