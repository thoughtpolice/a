// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! The worker the daemon runs for its own machine.
//!
//! It is the same worker `gonzo-worker` runs elsewhere, speaking the same
//! gRPC to the daemon, only over an in-memory pipe rather than the
//! network, so local and remote execution take one code path.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context as _, Result};
use tokio::io::DuplexStream;
use tonic::transport::{Channel, Endpoint};

/// Room in each direction of the pipe; HTTP/2 flow control keeps the
/// bytes in flight below it.
const PIPE_BYTES: usize = 4 * 1024 * 1024;

/// How the local worker runs.
#[derive(Clone, Debug)]
pub struct Settings {
    pub slots: usize,
    pub dir: PathBuf,
    pub cache_bytes: u64,
    pub default_timeout: Duration,
    pub max_timeout: Duration,
}

/// A channel to the daemon whose worker routes are served on the other
/// end of `handover`.
fn channel(handover: tokio::sync::mpsc::Sender<DuplexStream>) -> Channel {
    Endpoint::from_static("http://gonzo.local")
        .initial_connection_window_size(Some(PIPE_BYTES as u32))
        .initial_stream_window_size(Some(PIPE_BYTES as u32 / 2))
        .connect_with_connector_lazy(tower::service_fn(move |_: tonic::transport::Uri| {
            let handover = handover.clone();
            async move {
                let (ours, theirs) = tokio::io::duplex(PIPE_BYTES);
                handover.send(theirs).await.map_err(|_| {
                    std::io::Error::other("the daemon has stopped serving its worker")
                })?;
                Ok::<_, std::io::Error>(hyper_util::rt::TokioIo::new(ours))
            }
        }))
}

/// Start the local worker, reaching the daemon through `handover`, until
/// `shutdown` resolves.
pub fn spawn(
    settings: Settings,
    handover: tokio::sync::mpsc::Sender<DuplexStream>,
    shutdown: impl Future<Output = ()> + Send + 'static,
) -> Result<tokio::task::JoinHandle<()>> {
    let worker = worker::Worker::new(worker::Config {
        name: worker::host_name().unwrap_or_else(|| "local".to_string()),
        properties: worker::offered_properties(),
        slots: settings.slots,
        dir: settings.dir.clone(),
        cache_bytes: settings.cache_bytes,
        base_environment: worker::host_environment(),
        default_timeout: settings.default_timeout,
        max_timeout: settings.max_timeout,
    })
    .with_context(|| {
        format!(
            "failed to start the local worker in {}",
            settings.dir.display()
        )
    })?;
    let worker = Arc::new(worker);
    tracing::info!(
        slots = settings.slots,
        dir = %settings.dir.display(),
        "local worker starting"
    );
    Ok(tokio::spawn(async move {
        if let Err(e) = worker.serve(channel(handover), shutdown).await {
            tracing::error!("the local worker stopped: {e:#}");
        }
    }))
}
