// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! Workers on other machines, joining over iroh.
//!
//! The daemon's endpoint, the join key its tickets carry, and its join
//! code are kept in `mesh/` in a local store's directory, so that tickets
//! and the code keep working across restarts. Removing `mesh/join-key`
//! revokes every ticket made so far, and removing `mesh/join-code` makes
//! up a new code. A store elsewhere gets a new identity, key and code each
//! time.

use std::path::Path;

use anyhow::{Context as _, Result};

use crate::reapi_grpc::{self, Frontend};

/// How long the daemon waits for its relay before making its ticket.
const RELAY_WAIT: std::time::Duration = std::time::Duration::from_secs(3);

/// The daemon's endpoint, and a ticket for joining it.
pub struct Listening {
    pub endpoint: mesh::Endpoint,
    pub ticket: mesh::JoinTicket,
    /// The code workers join with, if they may.
    pub code: Option<mesh::JoinCode>,
    /// Announces the daemon under its code, if it has one, while kept.
    _announcer: Option<mesh::Announcer>,
}

/// Accept workers that join with the key in `dir` (or a new one, without
/// a directory), or with `code`, found and reached as `preset` says, until
/// `stopped` resolves. A daemon with a code announces itself under it on
/// the DHT (`dht`, or the public one).
pub async fn start(
    frontend: &Frontend,
    dir: Option<&Path>,
    preset: iroh_dial::Global,
    code: Option<mesh::JoinCode>,
    dht: Option<mesh::Dht>,
    stopped: impl Future<Output = ()> + Send + 'static,
) -> Result<Listening> {
    let (identity, key) = match dir {
        Some(dir) => (
            mesh::load_or_create_identity(&dir.join("identity"))
                .with_context(|| format!("failed to read or make {}/identity", dir.display()))?,
            mesh::JoinKey::load_or_create(&dir.join("join-key"))
                .with_context(|| format!("failed to read or make {}/join-key", dir.display()))?,
        ),
        None => (mesh::SecretKey::generate(), mesh::JoinKey::generate()),
    };
    let endpoint = mesh::bind(identity, true, preset)
        .await
        .context("failed to bind the iroh endpoint for workers")?;
    // A ticket carrying the daemon's relay reaches it even where address
    // lookup does not; without one in a moment, workers look it up by ID.
    let _ = tokio::time::timeout(RELAY_WAIT, endpoint.online()).await;
    let ticket = mesh::JoinTicket {
        daemon: endpoint.addr(),
        key: key.clone(),
    };

    let mut keys = vec![key];
    let announcer = match &code {
        Some(code) => {
            // Slow on purpose; see mesh::JoinCode.
            let cluster = {
                let code = code.clone();
                tokio::task::spawn_blocking(move || code.cluster()).await?
            };
            keys.push(cluster.key());
            let rendezvous = mesh::Cluster::rendezvous(&endpoint, dht)
                .context("failed to join the DHT to announce the daemon")?;
            tracing::info!("workers on other machines join with: gonzo-worker --join {code}");
            Some(cluster.announce(&rendezvous))
        }
        None => None,
    };
    let streams = mesh::serve(endpoint.clone(), keys);
    let frontend = frontend.clone();
    let closing = endpoint.clone();
    tokio::spawn(async move {
        if let Err(e) = reapi_grpc::serve_workers(streams, &frontend, stopped).await {
            tracing::error!("serving remote workers failed: {e}");
        }
        closing.close().await;
    });
    tracing::info!(endpoint = %endpoint.id(), "accepting workers over iroh");
    Ok(Listening {
        endpoint,
        ticket,
        code,
        _announcer: announcer,
    })
}
