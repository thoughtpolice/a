// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! Workers on other machines, joining over iroh.
//!
//! The daemon's endpoint, and the join key its tickets carry, are kept in
//! `mesh/` in a local store's directory, so that tickets keep working
//! across restarts; removing `mesh/join-key` revokes every ticket made so
//! far. A store elsewhere gets a new identity and key each time.

use std::path::Path;

use anyhow::{Context as _, Result};

use crate::reapi_grpc::{self, Frontend};

/// How long the daemon waits for its relay before making its ticket.
const RELAY_WAIT: std::time::Duration = std::time::Duration::from_secs(3);

/// The daemon's endpoint, and a ticket for joining it.
pub struct Listening {
    pub endpoint: mesh::Endpoint,
    pub ticket: mesh::JoinTicket,
}

/// Accept workers that join with the key in `dir` (or a new one, without
/// a directory), found and reached as `preset` says, until `stopped`
/// resolves.
pub async fn start(
    frontend: &Frontend,
    dir: Option<&Path>,
    preset: iroh_dial::Global,
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

    let streams = mesh::serve(endpoint.clone(), vec![key]);
    let frontend = frontend.clone();
    let closing = endpoint.clone();
    tokio::spawn(async move {
        if let Err(e) = reapi_grpc::serve_workers(streams, &frontend, stopped).await {
            tracing::error!("serving remote workers failed: {e}");
        }
        closing.close().await;
    });
    tracing::info!(endpoint = %endpoint.id(), "accepting workers over iroh");
    Ok(Listening { endpoint, ticket })
}
