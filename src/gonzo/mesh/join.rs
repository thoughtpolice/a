// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! The join handshake, on the first stream of a worker's connection.
//!
//! iroh authenticates each end of a connection as its endpoint ID, so what
//! is left is whether each may talk to the other. The worker sends a proof
//! that it knows the join key, bound to both IDs; the daemon checks it
//! against the keys it accepts and answers with a proof of its own, which
//! the worker checks. A peer without the key learns nothing it could
//! replay: proofs name the IDs of the two ends of this connection.

use std::time::Duration;

use iroh::EndpointId;
use iroh::endpoint::{Connection, ConnectionError, VarInt};

use crate::keys::JoinKey;

/// How long either side waits for the other's half of the handshake.
pub const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(15);

/// How a daemon closes a connection whose worker could not prove it knows
/// a join key.
pub const CLOSE_REFUSED: VarInt = VarInt::from_u32(1);

/// Why a handshake failed.
#[derive(Debug, thiserror::Error)]
pub enum JoinError {
    #[error("the worker does not know a join key this daemon accepts")]
    UnknownWorker,
    #[error(
        "the daemon could not prove it knows the join key; it is not the daemon the key is for"
    )]
    UnknownDaemon,
    #[error("the handshake took longer than {HANDSHAKE_TIMEOUT:?}")]
    TimedOut,
    #[error("the handshake failed: {0}")]
    Connection(String),
}

impl JoinError {
    fn connection(e: impl std::fmt::Display) -> Self {
        Self::Connection(e.to_string())
    }
}

fn proof(key: &JoinKey, role: &str, daemon: EndpointId, worker: EndpointId) -> blake3::Hash {
    let mut hasher = blake3::Hasher::new_keyed(&key.0);
    hasher.update(b"gonzo join v1 ");
    hasher.update(role.as_bytes());
    hasher.update(daemon.as_bytes());
    hasher.update(worker.as_bytes());
    hasher.finalize()
}

/// Whether `reason` is a daemon's refusal.
fn refused(reason: Option<ConnectionError>) -> bool {
    matches!(reason, Some(ConnectionError::ApplicationClosed(close)) if close.error_code == CLOSE_REFUSED)
}

/// What the other end sent: one proof, and nothing else.
fn read_proof(bytes: Vec<u8>) -> Option<blake3::Hash> {
    <[u8; 32]>::try_from(bytes)
        .ok()
        .map(blake3::Hash::from_bytes)
}

/// Join the daemon at the other end of `conn`, as the worker `me`.
pub async fn join(conn: &Connection, me: EndpointId, key: &JoinKey) -> Result<(), JoinError> {
    let daemon = conn.remote_id();
    let handshake = async {
        let (mut send, mut recv) = conn.open_bi().await.map_err(JoinError::connection)?;
        send.write_all(proof(key, "worker", daemon, me).as_bytes())
            .await
            .map_err(JoinError::connection)?;
        send.finish().map_err(JoinError::connection)?;
        let reply = match recv.read_to_end(64).await {
            Ok(reply) if !reply.is_empty() => reply,
            // A daemon that refuses closes the connection, saying why. The
            // stream it drops ends empty, and that end may arrive first.
            Ok(_) if refused(Some(conn.closed().await)) => return Err(JoinError::UnknownWorker),
            Ok(_) => return Err(JoinError::UnknownDaemon),
            Err(_) if refused(conn.close_reason()) => return Err(JoinError::UnknownWorker),
            Err(e) => return Err(JoinError::connection(e)),
        };
        match read_proof(reply) {
            Some(answer) if answer == proof(key, "daemon", daemon, me) => Ok(()),
            _ => Err(JoinError::UnknownDaemon),
        }
    };
    tokio::time::timeout(HANDSHAKE_TIMEOUT, handshake)
        .await
        .unwrap_or(Err(JoinError::TimedOut))
}

/// Admit the worker at the other end of `conn` to the daemon `me`, if it
/// proves it knows one of `keys`. A worker that cannot is sent away.
pub async fn admit(conn: &Connection, me: EndpointId, keys: &[JoinKey]) -> Result<(), JoinError> {
    let worker = conn.remote_id();
    let handshake = async {
        let (mut send, mut recv) = conn.accept_bi().await.map_err(JoinError::connection)?;
        let offered = recv.read_to_end(64).await.map_err(JoinError::connection)?;
        let key = read_proof(offered)
            .and_then(|offered| {
                keys.iter()
                    .find(|key| proof(key, "worker", me, worker) == offered)
            })
            .ok_or(JoinError::UnknownWorker)?;
        send.write_all(proof(key, "daemon", me, worker).as_bytes())
            .await
            .map_err(JoinError::connection)?;
        send.finish().map_err(JoinError::connection)
    };
    let result = tokio::time::timeout(HANDSHAKE_TIMEOUT, handshake)
        .await
        .unwrap_or(Err(JoinError::TimedOut));
    if result.is_err() {
        conn.close(CLOSE_REFUSED, b"not admitted");
    }
    result
}
